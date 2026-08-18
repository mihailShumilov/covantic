import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundleHash, canonicalize, sha256Canonical, verdictHash } from '../src/services/oracle/hash.js';
import { PythHermesSource } from '../src/services/oracle/price-sources/pyth-hermes.js';
import { PriceSourceUnavailableError } from '../src/services/oracle/types.js';

const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

describe('evidence hashing', () => {
  it('is insensitive to key order', () => {
    const a = { z: 1, a: { d: 4, c: 3 }, m: [1, { y: 2, x: 1 }] };
    const b = { a: { c: 3, d: 4 }, m: [1, { x: 1, y: 2 }], z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(sha256Canonical(a)).toBe(sha256Canonical(b));
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('drops undefined members so optional fields do not change the hash', () => {
    expect(sha256Canonical({ a: 1, b: undefined })).toBe(sha256Canonical({ a: 1 }));
  });

  it('excludes provenance so a replay of the same evidence hashes identically', () => {
    const evidence = { txSignature: 'Sig', prices: [{ value: 200, conf: 1 }] };
    const first = bundleHash({ ...evidence, collectedAt: 1_000, stage: 'verify' });
    const replay = bundleHash({ ...evidence, collectedAt: 9_999_999, stage: 'replay' });
    expect(replay).toBe(first);
  });

  it('changes when the evidence itself changes', () => {
    const base = bundleHash({ prices: [{ value: 200 }], collectedAt: 1 });
    const moved = bundleHash({ prices: [{ value: 201 }], collectedAt: 1 });
    expect(moved).not.toBe(base);
  });

  it('binds a verdict to the exact bundle it came from', () => {
    const h = bundleHash({ prices: [], collectedAt: 1 });
    const paid = verdictHash(h, { outcome: 'confirmed', lossAmount: 50 });
    const denied = verdictHash(h, { outcome: 'rejected', lossAmount: 0 });
    expect(paid).not.toBe(denied);
    expect(paid).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** Minimal Hermes response body. */
function hermesBody(publishTime: number, price = 20_000_000_000, conf = 5_000_000) {
  return {
    binary: { encoding: 'hex', data: ['504e4155deadbeef'] },
    parsed: [
      {
        id: SOL_FEED,
        price: { price: String(price), conf: String(conf), expo: -8, publish_time: publishTime },
        metadata: { slot: 309_118_306, prev_publish_time: publishTime - 1 },
      },
    ],
  };
}

function mockFetch(handler: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  return vi.fn(async (url: string) => {
    const { status, body, headers } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers?.[k.toLowerCase()] ?? null },
      json: async () => body,
    } as unknown as Response;
  });
}

/** Pull the requested unix timestamp back out of a Hermes URL. */
function requestedTs(url: string): number {
  return Number(url.match(/\/v2\/updates\/price\/(\d+)/)![1]);
}

describe('PythHermesSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('anchors the window on the requested block time', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) => ({ status: 200, body: hermesBody(requestedTs(url)) })),
    );

    const source = new PythHermesSource();
    const window = await source.getPriceWindow('SOL/USD', 1_700_000_000);

    expect(window).not.toBeNull();
    expect(window!.skewSec).toBe(0);
    expect(window!.anchor.publishTime).toBe(1_700_000_000);
    expect(window!.anchor.value).toBeCloseTo(200, 6);
    expect(window!.anchor.conf).toBeCloseTo(0.05, 6);
    // The signed update must survive verbatim: it is the proof material.
    expect(window!.anchor.raw).toBe('504e4155deadbeef');
  });

  it('probes backwards for the preceding sample when Hermes answers forward only', async () => {
    // Hermes returns the first update at or after the requested time, so a
    // feed that skipped the target second answers with a later sample. The
    // earlier side has to be fetched separately or the window is one-sided.
    vi.stubGlobal(
      'fetch',
      mockFetch((url) => {
        const ts = requestedTs(url);
        return { status: 200, body: hermesBody(ts === 1_700_000_000 ? 1_700_000_001 : ts) };
      }),
    );

    const source = new PythHermesSource();
    const window = await source.getPriceWindow('SOL/USD', 1_700_000_000, 2);

    expect(window!.after?.publishTime).toBe(1_700_000_001);
    expect(window!.before?.publishTime).toBe(1_699_999_998);
    // Anchor is whichever sample is closest, here the one a second later.
    expect(window!.anchor.publishTime).toBe(1_700_000_001);
    expect(window!.skewSec).toBe(1);
  });

  it('treats 404 as "no data for this feed", not an outage', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 404 })));
    const source = new PythHermesSource();
    await expect(source.getPriceAt('SOL/USD', 1_700_000_000)).resolves.toBeNull();
  });

  it('raises an unavailable error on rate limiting, honouring retry-after', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({ status: 429, headers: { 'retry-after': '17' } })),
    );
    const source = new PythHermesSource();

    // Must throw rather than resolve null: a 429 says nothing about the
    // price, and collapsing it into "no data" is what used to close valid
    // claims permanently.
    await expect(source.getPriceAt('SOL/USD', 1_700_000_000)).rejects.toBeInstanceOf(
      PriceSourceUnavailableError,
    );
    await expect(source.getPriceAt('SOL/USD', 1_700_000_001)).rejects.toMatchObject({
      retryAfterSec: 17,
      status: 429,
    });
  });

  it('raises an unavailable error when the network fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const source = new PythHermesSource();
    await expect(source.getPriceAt('SOL/USD', 1_700_000_000)).rejects.toBeInstanceOf(
      PriceSourceUnavailableError,
    );
  });

  it('caches by (feed, timestamp) since both are immutable', async () => {
    const fetchMock = mockFetch((url) => ({ status: 200, body: hermesBody(requestedTs(url)) }));
    vi.stubGlobal('fetch', fetchMock);

    const source = new PythHermesSource();
    await source.getPriceAt('SOL/USD', 1_700_000_000);
    await source.getPriceAt('SOL/USD', 1_700_000_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a raw hex feed id for feeds we have not named', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) => ({ status: 200, body: hermesBody(requestedTs(url)) })),
    );
    const source = new PythHermesSource();
    const point = await source.getPriceAt(SOL_FEED, 1_700_000_000);
    expect(point?.feedId).toBe(SOL_FEED);
  });

  it('returns null for an unknown feed key without calling the network', async () => {
    const fetchMock = mockFetch(() => ({ status: 200, body: hermesBody(1) }));
    vi.stubGlobal('fetch', fetchMock);
    const source = new PythHermesSource();
    expect(await source.getPriceAt('NOPE/USD', 1_700_000_000)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
