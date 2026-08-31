import { describe, expect, it, vi, afterEach } from 'vitest';
import type { RpcTransport } from '@solana/kit';
import { CovanticRpcPool, describeRpcFailure } from '../src/config/rpc-pool.js';

/**
 * Read-pool safety properties the existing suite leaves open.
 *
 * `rpc-pool.test.ts` covers the 429 cooldown, the skip-without-a-network-call,
 * and the skip-versus-failure accounting, and each of those genuinely fails
 * when the code behind it is broken. Three asserted properties had no test of
 * their own, and one of them survives every mutation of the shipped suite:
 *
 *   1. **A recovery resets the failure count.** Without it the counter is
 *      monotonic, so once an endpoint has failed three times in its life every
 *      single later failure re-opens the breaker immediately — the paid primary
 *      spends a long-running process mostly out of rotation while the free
 *      fallback carries the load. Nothing in the shipped suite notices.
 *   2. **Order is preference, not round-robin** (`CLAUDE.md`). A pool that
 *      spread reads evenly would make the paid endpoint's quota irrelevant and
 *      the free endpoint's rate limit the binding constraint.
 *   3. **A credential never leaves the process.** Provider API keys live in the
 *      query string, and `/api/health/rpc` serialises `status()` straight to an
 *      unauthenticated response.
 */

const HELIUS = 'https://devnet.helius-rpc.com/?api-key=secret-key-value';
const PUBLIC = 'https://api.devnet.solana.com';

function ok(slot: bigint, calls: string[] = [], name = 'ok'): RpcTransport {
  return (async () => {
    calls.push(name);
    return { jsonrpc: '2.0', id: 1, result: slot };
  }) as unknown as RpcTransport;
}

function failing(err: unknown, calls: string[] = [], name = 'bad'): RpcTransport {
  return (async () => {
    calls.push(name);
    throw err;
  }) as unknown as RpcTransport;
}

/** A transport whose health is flipped by the test between requests. */
function switchable(state: { healthy: boolean }, calls: string[], name: string): RpcTransport {
  return (async () => {
    calls.push(name);
    if (!state.healthy) throw new Error('down');
    return { jsonrpc: '2.0', id: 1, result: 1n };
  }) as unknown as RpcTransport;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('INV-RPC-01 — a recovery clears the endpoint\'s failure history', () => {
  it('does not re-trip on the next isolated failure after recovering', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const primary = { healthy: false };
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS ? switchable(primary, calls, 'primary') : ok(1n, calls, 'fallback'),
    });

    // Trip it: three consecutive failures.
    for (let i = 0; i < 3; i++) await pool.rpc.getSlot().send();
    expect(pool.status().endpoints[0]?.ejected).toBe(true);

    // Cooldown expires, the probe succeeds, the endpoint is back.
    vi.setSystemTime(Date.now() + 31_000);
    primary.healthy = true;
    await pool.rpc.getSlot().send();
    expect(pool.status().endpoints[0]?.consecutiveFailures).toBe(0);
    expect(pool.status().endpoints[0]?.cooldownSec).toBe(0);

    // Now two isolated failures. Below the threshold, so the endpoint must
    // stay in rotation — a monotonic counter would have re-opened the breaker
    // on the first one and kept the primary out for another 30 seconds.
    primary.healthy = false;
    await pool.rpc.getSlot().send();
    await pool.rpc.getSlot().send();

    const status = pool.status();
    // Still in rotation: two isolated failures are below the threshold, and a
    // monotonic counter would have re-ejected on the first one.
    expect(status.endpoints[0]?.ejected).toBe(false);
    expect(status.endpoints[0]?.cooldownSec).toBe(0);
    expect(status.endpoints[0]?.consecutiveFailures).toBe(2);
  });

  it('still re-opens on a single failure while half-open', async () => {
    // The other half of the same property: after a cooldown expires the
    // endpoint gets exactly one probe, and a probe that fails must not buy it
    // two more attempts before the breaker closes again.
    vi.useFakeTimers();
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS ? failing(new Error('down'), calls, 'primary') : ok(1n, calls, 'fallback'),
    });

    for (let i = 0; i < 3; i++) await pool.rpc.getSlot().send();
    expect(calls.filter((c) => c === 'primary')).toHaveLength(3);

    vi.setSystemTime(Date.now() + 31_000);
    await pool.rpc.getSlot().send(); // the probe, which fails
    expect(calls.filter((c) => c === 'primary')).toHaveLength(4);

    // Immediately closed again — no second and third attempt.
    await pool.rpc.getSlot().send();
    await pool.rpc.getSlot().send();
    expect(calls.filter((c) => c === 'primary')).toHaveLength(4);
    // Trip count is no longer surfaced: ejection is the kit's, and what an
    // operator acts on is whether the endpoint is out *now*, not how often it
    // has been.
    expect(pool.status().endpoints[0]?.ejected).toBe(true);
  });
});

describe('INV-RPC-02 — order is preference, not round-robin', () => {
  it('serves every request from the primary while it is healthy', async () => {
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: `${PUBLIC}, https://rpc.example.org`,
      transportFactory: (url) =>
        url === HELIUS ? ok(9n, calls, 'primary') : ok(9n, calls, url),
    });

    for (let i = 0; i < 8; i++) await pool.rpc.getSlot().send();

    // Spreading reads evenly would make the paid endpoint's quota irrelevant
    // and the free endpoint's rate limit the binding constraint on detection.
    expect(calls).toEqual(Array(8).fill('primary'));
  });

  it('probes no endpoint before the request, by default', async () => {
    // Freshness-aware routing probes `getSlot` on every endpoint before every
    // request. Correct, and it multiplies request volume by the endpoint count
    // — which is the very thing the pool exists to stop.
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) => ok(9n, calls, url === HELIUS ? 'primary' : 'fallback'),
    });

    await pool.rpc.getSlot().send();

    expect(calls).toEqual(['primary']);
  });

  it('returns to the primary once it recovers rather than sticking to the fallback', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const primary = { healthy: false };
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS ? switchable(primary, calls, 'primary') : ok(1n, calls, 'fallback'),
    });

    for (let i = 0; i < 3; i++) await pool.rpc.getSlot().send();
    vi.setSystemTime(Date.now() + 31_000);
    primary.healthy = true;

    calls.length = 0;
    for (let i = 0; i < 3; i++) await pool.rpc.getSlot().send();

    // Every call went to the primary — including the kit's own half-open
    // recovery probe, which is how an endpoint ranked last gets asked whether
    // it is back at all.
    expect(new Set(calls)).toEqual(new Set(['primary']));
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('INV-RPC-03 — no credential leaves the process', () => {
  it('keeps the api key out of everything status() returns', () => {
    // `/api/health/rpc` serialises this straight to an unauthenticated
    // response, so a URL that reached the status payload would be a published
    // provider key.
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: `${PUBLIC}?api-key=another-secret`,
      transportFactory: () => ok(1n),
    });

    const serialised = JSON.stringify(pool.status());

    expect(serialised).not.toContain('secret-key-value');
    expect(serialised).not.toContain('another-secret');
    expect(serialised).not.toContain('api-key');
    expect(pool.status().endpoints.map((e) => e.name)).toEqual([
      'devnet.helius-rpc.com',
      'api.devnet.solana.com',
    ]);
  });

  it('keeps the api key out of the message every endpoint failure produces', async () => {
    // This string is what `SolanaReader.rethrow` puts on the error, and it is
    // logged and stored on claim evidence.
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: () => failing(new Error('quota exceeded')),
    });

    const err = await pool.rpc
      .getSlot()
      .send()
      .catch((e: unknown) => e);

    expect(describeRpcFailure(err)).not.toContain('secret-key-value');
    expect(describeRpcFailure(err)).toContain('devnet.helius-rpc.com: quota exceeded');
  });

  it('passes a non-pool error through unchanged', () => {
    expect(describeRpcFailure(new Error('boom'))).toBe('boom');
    expect(describeRpcFailure('not an error')).toBe('not an error');
  });
});

describe('INV-RPC-04 — the health surface reports what actually happened', () => {
  it('reports no usable endpoint when every breaker is open', async () => {
    // What `/api/health/rpc` turns into `no-endpoint-available`. Getting this
    // wrong means an operator reads "ok" while nothing is being checkpointed.
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: () => failing(new Error('down')),
    });

    for (let i = 0; i < 3; i++) await pool.rpc.getSlot().send().catch(() => undefined);

    const status = pool.status();
    expect(status.endpoints.every((e) => e.cooldownSec > 0)).toBe(true);
    expect(status.endpoints.some((e) => e.healthy && e.cooldownSec === 0)).toBe(false);
    expect(status.successRate).toBe(0);
  });

  it('reports a full success rate when nothing failed', async () => {
    const pool = new CovanticRpcPool({ primaryUrl: HELIUS, transportFactory: () => ok(1n) });

    for (let i = 0; i < 4; i++) await pool.rpc.getSlot().send();

    expect(pool.status()).toMatchObject({ requests: 4, failures: 0, successRate: 1 });
  });
});
