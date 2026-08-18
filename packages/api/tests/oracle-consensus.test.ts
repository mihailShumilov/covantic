import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsensusPricer,
  median,
  relativeSpread,
} from '../src/services/oracle/consensus.js';
import {
  BinanceSource,
  CoinbaseSource,
  KrakenSource,
} from '../src/services/oracle/price-sources/cex.js';
import {
  PriceSourceUnavailableError,
  type PricePoint,
  type PriceSource,
  type PriceSourceId,
} from '../src/services/oracle/types.js';

const T = 1_700_000_000;

/** A source that answers with a fixed price, or fails in a chosen way. */
function stubSource(
  id: PriceSourceId,
  behaviour: { price?: number; conf?: number; at?: number; granularitySec?: number } | 'down' | 'empty',
): PriceSource {
  return {
    id,
    granularitySec:
      typeof behaviour === 'object' ? (behaviour.granularitySec ?? 1) : 1,
    async priceAt(feedId: string): Promise<PricePoint | null> {
      if (behaviour === 'down') {
        throw new PriceSourceUnavailableError(id, 'stub down', { retryAfterSec: 11 });
      }
      if (behaviour === 'empty') return null;
      return {
        value: behaviour.price ?? 100,
        conf: behaviour.conf ?? 0,
        publishTime: behaviour.at ?? T,
        slot: null,
        source: id,
        feedId,
        raw: id === 'pyth' ? 'ab01' : null,
      };
    },
  };
}

describe('median / relativeSpread', () => {
  it('takes the middle of an odd set and the mean of an even one', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('reports zero spread for a single value', () => {
    expect(relativeSpread([100])).toBe(0);
  });

  it('measures spread against the smaller end', () => {
    expect(relativeSpread([100, 110])).toBeCloseTo(0.1, 9);
  });
});

describe('ConsensusPricer', () => {
  it('takes the median so one corrupted source cannot move the answer', async () => {
    // The manipulated feed screams 300; the untouchable exchanges say 100.
    const pricer = new ConsensusPricer([
      stubSource('pyth', { price: 300 }),
      stubSource('binance', { price: 100 }),
      stubSource('coinbase', { price: 100 }),
      stubSource('kraken', { price: 100 }),
    ]);
    const window = await pricer.getPriceWindow('SOL/USD', T);
    expect(window!.anchor.value).toBe(100);
    expect(window!.sourceCount).toBe(4);
  });

  it('exposes the disagreement rather than hiding it behind the median', async () => {
    const pricer = new ConsensusPricer([
      stubSource('pyth', { price: 300 }),
      stubSource('binance', { price: 100 }),
      stubSource('coinbase', { price: 100 }),
    ]);
    const window = await pricer.getPriceWindow('SOL/USD', T);
    // The caller needs to see 200% spread to know the median is untrustworthy.
    expect(window!.dispersion).toBeCloseTo(2, 6);
  });

  it('widens confidence to the observed spread when sources claim precision they do not have', async () => {
    const pricer = new ConsensusPricer([
      stubSource('pyth', { price: 100, conf: 0.01 }),
      stubSource('binance', { price: 102, conf: 0.01 }),
      stubSource('coinbase', { price: 101, conf: 0.01 }),
    ]);
    const window = await pricer.getPriceWindow('SOL/USD', T);
    // Three sources each claiming +/-0.01 while sitting 2% apart are
    // contradicting themselves; the honest interval is the spread.
    expect(window!.anchor.conf).toBeGreaterThan(0.5);
  });

  it('carries on when one source is down', async () => {
    const pricer = new ConsensusPricer([
      stubSource('pyth', { price: 100 }),
      stubSource('binance', 'down'),
      stubSource('coinbase', { price: 100 }),
      stubSource('kraken', { price: 100 }),
    ]);
    const window = await pricer.getPriceWindow('SOL/USD', T);
    expect(window!.sourceCount).toBe(3);
    expect(window!.missing).toEqual([{ source: 'binance', reason: 'stub down' }]);
  });

  it('raises an outage only when every source is down', async () => {
    const pricer = new ConsensusPricer([stubSource('pyth', 'down'), stubSource('binance', 'down')]);
    await expect(pricer.getPriceWindow('SOL/USD', T)).rejects.toBeInstanceOf(
      PriceSourceUnavailableError,
    );
  });

  it('returns no data — not an outage — when sources are merely silent', async () => {
    const pricer = new ConsensusPricer([stubSource('pyth', 'empty'), stubSource('binance', 'empty')]);
    await expect(pricer.getPriceWindow('WHAT/USD', T)).resolves.toBeNull();
  });

  it('holds each source to its own resolution', async () => {
    // 40s off the mark: far too stale for a sub-second feed, entirely normal
    // for a minute candle.
    const pricer = new ConsensusPricer([
      stubSource('pyth', { price: 100, at: T - 40, granularitySec: 1 }),
      stubSource('binance', { price: 100, at: T - 40, granularitySec: 60 }),
      stubSource('coinbase', { price: 100, at: T - 40, granularitySec: 60 }),
    ]);
    const window = await pricer.getPriceWindow('SOL/USD', T);
    expect(window!.sourceCount).toBe(2);
    expect(window!.missing).toEqual([{ source: 'pyth', reason: 'stale:40s' }]);
  });

  it('keeps a signed proof when any contributor has one', async () => {
    const pricer = new ConsensusPricer([
      stubSource('binance', { price: 100 }),
      stubSource('pyth', { price: 100 }),
    ]);
    const window = await pricer.getPriceWindow('SOL/USD', T);
    expect(window!.anchor.raw).toBe('ab01');
  });

  it('does not let a broken adapter take the consensus down with it', async () => {
    const rogue: PriceSource = {
      id: 'jupiter',
      granularitySec: 1,
      async priceAt() {
        throw new TypeError('adapter bug');
      },
    };
    const pricer = new ConsensusPricer([
      rogue,
      stubSource('pyth', { price: 100 }),
      stubSource('binance', { price: 100 }),
    ]);
    const window = await pricer.getPriceWindow('SOL/USD', T);
    expect(window!.sourceCount).toBe(2);
  });
});

function mockFetch(handler: (url: string) => { status: number; body?: unknown }) {
  return vi.fn(async (url: string) => {
    const { status, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    } as unknown as Response;
  });
}

describe('exchange sources', () => {
  afterEach(() => vi.unstubAllGlobals());

  // 1_700_000_000 falls in the bucket starting at 1_699_999_980.
  const BUCKET = 1_699_999_980;

  it('reads a Binance kline as a mid with half-range confidence', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({
        status: 200,
        body: [[BUCKET * 1000, '99', '102', '98', '101', '10']],
      })),
    );
    const point = await new BinanceSource().priceAt('SOL/USD', T);
    expect(point!.value).toBe(100);
    expect(point!.conf).toBe(2);
    // Dated at the midpoint of the minute, not its start.
    expect(point!.publishTime).toBe(BUCKET + 30);
  });

  it('handles the Coinbase column order, where low precedes high', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({ status: 200, body: [[BUCKET, 98, 102, 99, 101, 10]] })),
    );
    const point = await new CoinbaseSource().priceAt('SOL/USD', T);
    expect(point!.value).toBe(100);
    expect(point!.conf).toBe(2);
  });

  it('picks the exact bucket out of a Kraken series', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({
        status: 200,
        body: {
          error: [],
          result: {
            SOLUSD: [
              [BUCKET - 60, '1', '9', '1', '1', '1', '1', 1],
              [BUCKET, '99', '102', '98', '101', '100', '5', 3],
            ],
            last: [],
          },
        },
      })),
    );
    const point = await new KrakenSource().priceAt('SOL/USD', T);
    expect(point!.value).toBe(100);
  });

  it('treats a Kraken pair error as no data, not an outage', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({ status: 200, body: { error: ['EQuery:Unknown asset pair'] } })),
    );
    await expect(new KrakenSource().priceAt('SOL/USD', T)).resolves.toBeNull();
  });

  it('reports an unlisted pair as no data without calling out', async () => {
    const fetchMock = mockFetch(() => ({ status: 200, body: [] }));
    vi.stubGlobal('fetch', fetchMock);
    // Binance does not list JitoSOL; that is a coverage gap, not a failure.
    await expect(new BinanceSource().priceAt('JITOSOL/USD', T)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('raises an outage on a rate limit', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ status: 429 })));
    await expect(new BinanceSource().priceAt('SOL/USD', T)).rejects.toBeInstanceOf(
      PriceSourceUnavailableError,
    );
  });

  it('ignores a candle from the wrong bucket', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({
        status: 200,
        body: [[(BUCKET + 600) * 1000, '99', '102', '98', '101', '10']],
      })),
    );
    await expect(new BinanceSource().priceAt('SOL/USD', T)).resolves.toBeNull();
  });
});
