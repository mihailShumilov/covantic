import { logger } from '../../../utils/logger.js';
import {
  PriceSourceUnavailableError,
  type PricePoint,
  type PriceSource,
  type PriceWindow,
} from '../types.js';

/** Outbound timeout — see the note in `cex.ts`. */
const HTTP_TIMEOUT_MS = 5_000;

/**
 * Pyth Hermes REST endpoint.
 *
 * Pyth retired the anonymous host on 2026-08-26: `hermes.pyth.network` now
 * answers `401 unauthorized` on every route, and the replacement is
 * `pyth.dourolabs.app/hermes` with a bearer credential from Pyth Terminal.
 * The routes and response shapes did not change, so the default points at
 * the new host and the only missing piece is `PYTH_HERMES_API_KEY`.
 * `PYTH_HERMES_URL` stays configurable for a self-hosted Hermes.
 *
 * Running without the credential is degraded, not broken, and not silent. A
 * 401 raises {@link PriceSourceUnavailableError} like any other outage, which
 * excludes Pyth from the consensus and records the reason in the bundle's
 * `missing[]` — the claim still resolves against the four exchange
 * references, one source short, and the shortfall is visible to whoever
 * reads the evidence.
 *
 * What the credential *does* gate is the proof path. `verify_and_payout_v2`
 * pays only against a guardian-signed update the program verifies for itself,
 * and that update comes from here. Until a key is set, an oracle claim can
 * reach `confirmed` on exchange evidence but never the auto-pay lane — which
 * is why `ORACLE_PROOF_ENABLED` is the one proof flag still off in
 * production. See `docs/M1_RESULTS.md` §4.
 */
const PYTH_HERMES_URL = process.env.PYTH_HERMES_URL ?? 'https://pyth.dourolabs.app/hermes';

/** Optional bearer credential for the configured Hermes host. */
const PYTH_HERMES_API_KEY = process.env.PYTH_HERMES_API_KEY ?? '';

/**
 * Pyth price feed IDs (hex, without 0x prefix).
 * Feed IDs are chain-agnostic — the same id serves mainnet and devnet.
 * See: https://pyth.network/developers/price-feed-ids
 */
export const FEED_IDS: Record<string, string> = {
  'SOL/USD': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'BTC/USD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'USDC/USD': 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  'USDT/USD': '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
  'JITOSOL/USD': '67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb',
  'MSOL/USD': 'c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4',
};

/** Default tolerance between a price sample and the transaction block time.
 *  Pyth publishes roughly every 400ms, so a legitimate lookup lands within a
 *  second. Anything wider means the feed was stalled at the moment we care
 *  about, which is itself information rather than a reason to guess. */
export const DEFAULT_MAX_SKEW_SEC = 2;

/** Bound on the (feedId, timestamp) -> PricePoint cache. Both components are
 *  immutable so entries never go stale; the cap only limits memory. */
const CACHE_LIMIT = 2_000;

interface HermesPriceEntry {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

interface HermesParsedEntry {
  id: string;
  price?: HermesPriceEntry;
  ema_price?: HermesPriceEntry;
  metadata?: {
    slot?: number;
    prev_publish_time?: number;
    proof_available_time?: number;
  };
}

interface HermesResponse {
  binary?: { encoding: string; data: string[] };
  parsed?: HermesParsedEntry[];
}

/** Legacy shape kept for existing callers of {@link PythHermesSource.getPrice}. */
export interface PythPrice {
  price: number;
  confidence: number;
  timestamp: number;
}

/**
 * Historical, signed price lookups from Pyth Hermes.
 *
 * The important difference from a plain spot read: every method is anchored
 * to an explicit unix timestamp. A claim is always retrospective — the
 * transaction under review executed in the past — so comparing it against
 * the price *now* measures market drift, not manipulation. That confusion
 * was the single most severe bug in the original verifier.
 *
 * Each observation carries the raw Wormhole accumulator update from
 * `binary.data[0]`. Those are the exact bytes `pyth-solana-receiver` verifies
 * on-chain, so retaining them is what lets a payout be proven rather than
 * asserted.
 */
export class PythHermesSource implements PriceSource {
  readonly id = 'pyth' as const;
  /** Pyth publishes roughly every 400ms; one second is the finest the Hermes
   *  timestamp API addresses. */
  readonly granularitySec = 1;

  private readonly cache = new Map<string, PricePoint | null>();

  constructor(
    private readonly baseUrl: string = PYTH_HERMES_URL,
    private readonly apiKey: string = PYTH_HERMES_API_KEY,
  ) {}

  /** Auth header for the configured host, or nothing when it needs none. */
  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  /** {@link PriceSource} entry point. Same as {@link getPriceAt}. */
  priceAt(feedKey: string, unixTime: number): Promise<PricePoint | null> {
    return this.getPriceAt(feedKey, unixTime);
  }

  /** Resolve a friendly feed key (`SOL/USD`) to its hex id. Passing a raw
   *  64-char hex id through is allowed so callers can use feeds we have not
   *  named yet. */
  resolveFeedId(feedKey: string): string | null {
    if (FEED_IDS[feedKey]) return FEED_IDS[feedKey];
    if (/^[0-9a-f]{64}$/i.test(feedKey)) return feedKey.toLowerCase();
    return null;
  }

  /**
   * The Pyth update closest to `unixTime`.
   *
   * Hermes returns the first update whose `publish_time >= unixTime`.
   * Returns `null` when the feed genuinely has no data around that time
   * (unknown feed, or before the feed existed). Throws
   * {@link PriceSourceUnavailableError} when Hermes itself is unreachable or
   * rate-limiting — the caller must treat that as indeterminate and retry,
   * never as evidence that no loss occurred.
   */
  async getPriceAt(feedKey: string, unixTime: number): Promise<PricePoint | null> {
    const feedId = this.resolveFeedId(feedKey);
    if (!feedId) {
      logger.warn({ feedKey }, 'pyth: unknown feed key');
      return null;
    }
    const ts = Math.floor(unixTime);
    if (!Number.isFinite(ts) || ts <= 0) return null;

    const cacheKey = `${feedId}:${ts}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const url =
      `${this.baseUrl}/v2/updates/price/${ts}` + `?ids[]=${feedId}&parsed=true&binary=true`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PriceSourceUnavailableError('pyth', `Hermes fetch failed: ${String(error)}`, {
        retryAfterSec: 30,
      });
    }

    // 404 means "no update at that timestamp" — a real answer about the feed,
    // not an outage. Everything else is an outage.
    if (res.status === 404) {
      this.remember(cacheKey, null);
      return null;
    }
    if (!res.ok) {
      const retryAfterSec = parseRetryAfter(res.headers.get('retry-after')) ?? 60;
      throw new PriceSourceUnavailableError('pyth', `Hermes HTTP ${res.status}`, {
        retryAfterSec,
        status: res.status,
      });
    }

    let data: HermesResponse;
    try {
      data = (await res.json()) as HermesResponse;
    } catch (error) {
      throw new PriceSourceUnavailableError('pyth', `Hermes bad JSON: ${String(error)}`, {
        retryAfterSec: 30,
      });
    }

    // Match the requested feed only. The previous `?? data.parsed?.[0]`
    // fallback accepted whatever Hermes happened to return and then stamped it
    // with the feed id we asked for — so a mismatched response became a
    // confident price for the wrong asset, with nothing downstream able to
    // tell. A response that does not contain the feed is an unusable response.
    const entry = data.parsed?.find((p) => p.id?.toLowerCase() === feedId);
    if (data.parsed?.length && !entry) {
      throw new PriceSourceUnavailableError(
        'pyth',
        `Hermes returned ${data.parsed.length} feed(s), none matching ${feedId}`,
        { retryAfterSec: 30 },
      );
    }
    const priceData = entry?.price;
    if (!priceData) {
      this.remember(cacheKey, null);
      return null;
    }

    // `publish_time` drives both staleness gates. Undefined makes the skew
    // NaN, and `NaN > tolerance` is false, so both gates would silently pass.
    if (typeof priceData.publish_time !== 'number' || !Number.isFinite(priceData.publish_time)) {
      throw new PriceSourceUnavailableError(
        'pyth',
        `Hermes entry for ${feedId} carried no usable publish_time`,
        { retryAfterSec: 30 },
      );
    }

    const scale = Math.pow(10, priceData.expo);
    const point: PricePoint = {
      value: Number(priceData.price) * scale,
      conf: Number(priceData.conf) * scale,
      publishTime: priceData.publish_time,
      slot: entry?.metadata?.slot ?? null,
      source: 'pyth',
      feedId,
      raw: data.binary?.data?.[0] ?? null,
    };
    this.remember(cacheKey, point);
    return point;
  }

  /**
   * The samples bracketing `targetTime`, plus the closest one.
   *
   * Hermes only answers "first update at or after T", so recovering the
   * *preceding* sample takes a second probe. Both sides are carried into the
   * bundle: a verdict built on a one-sided window is weaker evidence, and the
   * adjudicator is entitled to know that.
   */
  async getPriceWindow(
    feedKey: string,
    targetTime: number,
    maxSkewSec: number = DEFAULT_MAX_SKEW_SEC,
  ): Promise<PriceWindow | null> {
    const feedId = this.resolveFeedId(feedKey);
    if (!feedId) return null;

    const target = Math.floor(targetTime);
    const probeBack = Math.max(1, Math.floor(maxSkewSec));

    const at = await this.getPriceAt(feedKey, target);

    let before: PricePoint | null = null;
    let after: PricePoint | null = null;
    if (at) {
      if (at.publishTime <= target) before = at;
      if (at.publishTime >= target) after = at;
    }

    if (!before) {
      const probe = await this.getPriceAt(feedKey, target - probeBack);
      if (probe && probe.publishTime <= target) before = probe;
    }

    const candidates = [before, after].filter((p): p is PricePoint => p !== null);
    if (candidates.length === 0) return null;

    const anchor = candidates.reduce((a, b) =>
      Math.abs(a.publishTime - target) <= Math.abs(b.publishTime - target) ? a : b,
    );

    return {
      feedId,
      source: 'pyth',
      targetTime: target,
      before,
      after,
      anchor,
      skewSec: Math.abs(anchor.publishTime - target),
    };
  }

  /**
   * Current price for a feed.
   *
   * Retained for the risk-scoring and dashboard paths that legitimately want
   * "right now". Claim verification must never use this — see
   * {@link getPriceWindow}.
   */
  async getPrice(feedKey: string): Promise<PythPrice | null> {
    const feedId = this.resolveFeedId(feedKey);
    if (!feedId) {
      logger.warn({ feedKey }, 'Unknown Pyth feed ID');
      return null;
    }

    const url = `${this.baseUrl}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
    try {
      const res = await fetch(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.error({ feedKey, status: res.status }, 'Pyth Hermes API error');
        return null;
      }
      const data = (await res.json()) as HermesResponse;
      const priceData = data.parsed?.[0]?.price;
      if (!priceData) {
        logger.warn({ feedKey }, 'No price data in Pyth response');
        return null;
      }
      const scale = Math.pow(10, priceData.expo);
      return {
        price: Number(priceData.price) * scale,
        confidence: Number(priceData.conf) * scale,
        timestamp: priceData.publish_time,
      };
    } catch (error) {
      logger.error({ error, feedKey }, 'Failed to fetch Pyth price');
      return null;
    }
  }

  /** @deprecated Spot price at call time. Never valid for claim
   *  verification — use {@link getPriceWindow} anchored to the trigger
   *  transaction's block time. */
  async getSpotPrice(feedKey: string): Promise<number | null> {
    const price = await this.getPrice(feedKey);
    return price?.price ?? null;
  }

  private remember(key: string, value: PricePoint | null): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) : null;
}
