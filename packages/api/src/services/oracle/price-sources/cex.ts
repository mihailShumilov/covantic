import { logger } from '../../../utils/logger.js';
import {
  PriceSourceUnavailableError,
  type PricePoint,
  type PriceSource,
  type PriceSourceId,
} from '../types.js';

/** Outbound timeout. The sweep runs on a 120s tick; a source that has not
 *  answered in 5s has already cost more than its price is worth. */
const HTTP_TIMEOUT_MS = 5_000;

/**
 * Centralised-exchange price references.
 *
 * These carry weight out of proportion to their sophistication: they are the
 * only references in the set that an on-chain attacker cannot influence. A
 * manipulation that moves a Solana pool and the oracle reading it still
 * leaves Binance, Coinbase and Kraken untouched, so a swap that looks fine
 * against every chain-native source but terrible against all three exchanges
 * is exactly the signal worth having.
 *
 * All three serve minute candles by timestamp, which is what makes them
 * usable for retrospective claim verification at all. The trade-off is
 * resolution: a 60-second bucket cannot pin a price to the second, so each
 * observation is reported as the mid of the bucket's range with half that
 * range as its confidence interval. That is an honest statement of what a
 * candle knows.
 */

const CANDLE_SEC = 60;

/** Start of the minute bucket containing `unixTime`. */
function bucketStart(unixTime: number): number {
  return Math.floor(unixTime / CANDLE_SEC) * CANDLE_SEC;
}

/**
 * Build an observation from a candle's high/low.
 *
 * The mid is the best point estimate a bucket supports, and half the range is
 * a truthful uncertainty: the price provably was somewhere in [low, high]
 * during that minute. Reporting the close with zero confidence would claim
 * precision the data does not have, and the confidence interval feeds
 * directly into the deviation threshold.
 */
function candlePoint(
  source: PriceSourceId,
  feedId: string,
  bucket: number,
  high: number,
  low: number,
): PricePoint | null {
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= 0 || low <= 0) return null;
  return {
    value: (high + low) / 2,
    conf: Math.abs(high - low) / 2,
    // Midpoint of the bucket: the observation summarises the whole minute,
    // so dating it at the start would systematically bias the skew.
    publishTime: bucket + CANDLE_SEC / 2,
    slot: null,
    source,
    feedId,
    // Exchange REST responses are not signed. Absence of proof is recorded
    // rather than faked; the confidence scorer discounts for it.
    raw: null,
  };
}

async function fetchJson(
  source: PriceSourceId,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (error) {
    throw new PriceSourceUnavailableError(source, `fetch failed: ${String(error)}`, {
      retryAfterSec: 30,
    });
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new PriceSourceUnavailableError(source, `HTTP ${res.status}`, {
      status: res.status,
      retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 600) : 60,
    });
  }
  try {
    return await res.json();
  } catch (error) {
    throw new PriceSourceUnavailableError(source, `bad JSON: ${String(error)}`, {
      retryAfterSec: 30,
    });
  }
}

/** Shared cache. `(source, feed, bucket)` is immutable once the minute has
 *  closed, so entries never need invalidating. */
const CACHE_LIMIT = 4_000;

abstract class CandleSource implements PriceSource {
  abstract readonly id: PriceSourceId;
  readonly granularitySec = CANDLE_SEC;
  /** Canonical feed key -> this exchange's symbol. Absent means the exchange
   *  does not list the pair, which is a coverage gap, not an error. */
  protected abstract symbolFor(feedKey: string): string | null;
  protected abstract load(symbol: string, bucket: number): Promise<PricePoint | null>;

  private readonly cache = new Map<string, PricePoint | null>();

  async priceAt(feedKey: string, unixTime: number): Promise<PricePoint | null> {
    const symbol = this.symbolFor(feedKey);
    if (!symbol) return null;
    const bucket = bucketStart(unixTime);
    const key = `${symbol}:${bucket}`;

    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const point = await this.load(symbol, bucket);
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, point);
    return point;
  }
}

const BINANCE_SYMBOLS: Record<string, string> = {
  'SOL/USD': 'SOLUSDT',
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT',
  'USDC/USD': 'USDCUSDT',
};

export class BinanceSource extends CandleSource {
  readonly id = 'binance' as const;
  constructor(private readonly baseUrl = 'https://api.binance.com') {
    super();
  }
  protected symbolFor(feedKey: string): string | null {
    return BINANCE_SYMBOLS[feedKey] ?? null;
  }
  protected async load(symbol: string, bucket: number): Promise<PricePoint | null> {
    const url =
      `${this.baseUrl}/api/v3/klines?symbol=${symbol}&interval=1m` +
      `&startTime=${bucket * 1000}&limit=1`;
    // Kline row: [openTime, open, high, low, close, ...]
    const rows = (await fetchJson(this.id, url)) as unknown[][] | null;
    const row = rows?.[0];
    if (!row) return null;
    if (Number(row[0]) !== bucket * 1000) {
      // Binance returned a different bucket, which means ours has no trades.
      logger.debug({ symbol, bucket, got: row[0] }, 'binance: bucket mismatch');
      return null;
    }
    return candlePoint(this.id, symbol, bucket, Number(row[2]), Number(row[3]));
  }
}

const COINBASE_SYMBOLS: Record<string, string> = {
  'SOL/USD': 'SOL-USD',
  'BTC/USD': 'BTC-USD',
  'ETH/USD': 'ETH-USD',
  'USDT/USD': 'USDT-USD',
};

export class CoinbaseSource extends CandleSource {
  readonly id = 'coinbase' as const;
  constructor(private readonly baseUrl = 'https://api.exchange.coinbase.com') {
    super();
  }
  protected symbolFor(feedKey: string): string | null {
    return COINBASE_SYMBOLS[feedKey] ?? null;
  }
  protected async load(symbol: string, bucket: number): Promise<PricePoint | null> {
    const url =
      `${this.baseUrl}/products/${symbol}/candles` +
      `?start=${bucket}&end=${bucket + CANDLE_SEC}&granularity=${CANDLE_SEC}`;
    // Candle row: [time, low, high, open, close, volume] — note that low
    // precedes high here, unlike every other exchange in this file.
    const rows = (await fetchJson(this.id, url, {
      'User-Agent': 'covantic-claim-oracle/1.0',
    })) as unknown[][] | null;
    const row = rows?.find((r) => Number(r[0]) === bucket);
    if (!row) return null;
    return candlePoint(this.id, symbol, bucket, Number(row[2]), Number(row[1]));
  }
}

const KRAKEN_SYMBOLS: Record<string, string> = {
  'SOL/USD': 'SOLUSD',
  // Kraken lists bitcoin as XBT.
  'BTC/USD': 'XBTUSD',
  'ETH/USD': 'ETHUSD',
  'USDC/USD': 'USDCUSD',
  'USDT/USD': 'USDTZUSD',
};

export class KrakenSource extends CandleSource {
  readonly id = 'kraken' as const;
  constructor(private readonly baseUrl = 'https://api.kraken.com') {
    super();
  }
  protected symbolFor(feedKey: string): string | null {
    return KRAKEN_SYMBOLS[feedKey] ?? null;
  }
  protected async load(symbol: string, bucket: number): Promise<PricePoint | null> {
    // `since` is exclusive-ish, so step back one bucket and select exactly.
    const url = `${this.baseUrl}/0/public/OHLC?pair=${symbol}&interval=1&since=${bucket - CANDLE_SEC}`;
    const body = (await fetchJson(this.id, url)) as {
      error?: string[];
      result?: Record<string, unknown[][]>;
    } | null;
    if (!body) return null;
    if (body.error?.length) {
      // Kraken reports unknown pairs as errors rather than empty results.
      logger.debug({ symbol, error: body.error }, 'kraken: OHLC error');
      return null;
    }
    const series = Object.entries(body.result ?? {}).find(([k]) => k !== 'last')?.[1];
    const row = series?.find((r) => Number(r[0]) === bucket);
    if (!row) return null;
    return candlePoint(this.id, symbol, bucket, Number(row[2]), Number(row[3]));
  }
}

/** The exchange references, in no particular order — consensus treats them
 *  equally and never falls back to a preferred one. */
export function defaultCexSources(): PriceSource[] {
  return [new BinanceSource(), new CoinbaseSource(), new KrakenSource()];
}
