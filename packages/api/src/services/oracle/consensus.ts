import { logger } from '../../utils/logger.js';
import {
  isSourceUnavailable,
  PriceSourceUnavailableError,
  type PriceOracle,
  type PricePoint,
  type PriceSource,
  type PriceSourceId,
  type PriceWindow,
} from './types.js';

/**
 * Agreement across independent price references.
 *
 * The problem this solves is the one the original verifier walked straight
 * into: it used Pyth to decide whether Pyth had been manipulated. If the
 * manipulated feed is also the reference, the attacker's price is certified
 * as fair and the claim is denied. No amount of threshold tuning fixes that,
 * because the reference itself is the compromised input.
 *
 * So a verdict is built on several sources that cannot be moved by the same
 * action, and two numbers come out of them:
 *
 *   - the **fair price**, the median across sources, which a single corrupted
 *     source cannot shift;
 *   - the **dispersion**, how far apart the sources are, which is what a
 *     corrupted source actually looks like from the outside.
 *
 * Wide dispersion is never resolved by picking a favourite. References that
 * disagree prove nothing about the trade, and the honest output is
 * "indeterminate" — which the caller turns into review, not a denial.
 */

export interface ConsensusPolicy {
  /** Sources required before a price may support a manipulation finding. */
  minSources: number;
  /** Largest tolerable relative spread between sources. */
  maxDispersion: number;
  /** Extra slack, on top of a source's own granularity, between its sample
   *  and the requested time. */
  skewToleranceSec: number;
}

export const DEFAULT_CONSENSUS_POLICY: ConsensusPolicy = {
  // Three, not two: with two sources a disagreement is unattributable — you
  // know one is wrong but not which.
  minSources: 3,
  // Wide enough to survive minute-candle granularity and ordinary volatility,
  // tight enough that a manipulation large enough to be worth insuring
  // against blows straight through it.
  maxDispersion: 0.02,
  skewToleranceSec: 2,
};

export interface ConsensusPriceWindow extends PriceWindow {
  contributors: PricePoint[];
  dispersion: number;
  sourceCount: number;
  missing: Array<{ source: PriceSourceId; reason: string }>;
}

/**
 * A {@link PriceOracle} backed by several independent sources.
 *
 * Deliberately never throws on a thin or divergent result. Whether three
 * agreeing sources are required is a question about the *verdict*, not about
 * the lookup — a stablecoin leg valued from one source is fine, while the
 * priced leg carrying the deviation is not. So this reports what it found and
 * lets the valuation layer apply the policy that fits each leg.
 *
 * An individual source going down is absorbed here; only a total wipeout
 * propagates, because that is indistinguishable from having no evidence.
 */
export class ConsensusPricer implements PriceOracle {
  constructor(
    private readonly sources: PriceSource[],
    private readonly policy: ConsensusPolicy = DEFAULT_CONSENSUS_POLICY,
  ) {
    if (sources.length === 0) throw new Error('ConsensusPricer requires at least one source');
  }

  get sourceIds(): PriceSourceId[] {
    return this.sources.map((s) => s.id);
  }

  async getPriceWindow(
    feedKey: string,
    targetTime: number,
    maxSkewSec: number = this.policy.skewToleranceSec,
  ): Promise<ConsensusPriceWindow | null> {
    const target = Math.floor(targetTime);
    const contributors: PricePoint[] = [];
    const missing: Array<{ source: PriceSourceId; reason: string }> = [];
    let unavailableCount = 0;

    const settled = await Promise.all(
      this.sources.map(async (source) => {
        try {
          return { source, point: await source.priceAt(feedKey, target) };
        } catch (err) {
          if (isSourceUnavailable(err)) return { source, error: err.message, unavailable: true };
          // A source throwing something unexpected is a bug in that adapter.
          // It must not take the whole consensus down with it.
          logger.error(
            { err, source: source.id, feedKey },
            'consensus: source threw unexpectedly, excluding it',
          );
          return { source, error: String(err), unavailable: true };
        }
      }),
    );

    for (const entry of settled) {
      const { source } = entry;
      if ('error' in entry && entry.error !== undefined) {
        unavailableCount += 1;
        missing.push({ source: source.id, reason: entry.error });
        continue;
      }
      const point = 'point' in entry ? entry.point : null;
      if (!point) {
        missing.push({ source: source.id, reason: 'no_data' });
        continue;
      }
      // Each source is held to its own resolution: a minute candle cannot be
      // judged against a two-second tolerance, and a Pyth sample from ten
      // minutes away is stale even though a candle from one minute away is not.
      const tolerance = source.granularitySec + maxSkewSec;
      const skew = Math.abs(point.publishTime - target);
      if (skew > tolerance) {
        missing.push({ source: source.id, reason: `stale:${skew}s` });
        continue;
      }
      contributors.push(point);
    }

    if (contributors.length === 0) {
      // Nothing answered. If that is because every source was down we owe the
      // caller an outage, not a claim about the feed having no data.
      if (unavailableCount === this.sources.length) {
        const first = missing[0];
        throw new PriceSourceUnavailableError(
          'consensus',
          `all ${this.sources.length} price sources unavailable: ${first?.reason}`,
          { retryAfterSec: 60 },
        );
      }
      return null;
    }

    return buildConsensusWindow(feedKey, target, contributors, missing);
  }
}

/**
 * Assemble the agreed window from observations that already passed staleness.
 *
 * Split out of the class because it is the whole of the consensus *judgement*
 * and none of the I/O, which lets a replay price a frozen transaction through
 * exactly this arithmetic. A backtest that built its own window would be
 * measuring a second implementation, and the one number nobody would notice
 * drifting is the one that decides whether a fill was fair.
 */
export function buildConsensusWindow(
  feedKey: string,
  target: number,
  contributors: PricePoint[],
  missing: Array<{ source: PriceSourceId; reason: string }> = [],
): ConsensusPriceWindow | null {
  if (contributors.length === 0) return null;

  const fairPrice = median(contributors.map((p) => p.value));
  const dispersion = relativeSpread(contributors.map((p) => p.value));
  const anchor = buildAnchor(feedKey, target, contributors, fairPrice, dispersion);

  return {
    feedId: feedKey,
    source: 'consensus',
    targetTime: target,
    // The bracketing pair is a single-source notion; consensus reports the
    // agreed point and the spread that produced it instead.
    before: null,
    after: null,
    anchor,
    skewSec: Math.min(...contributors.map((p) => Math.abs(p.publishTime - target))),
    contributors,
    dispersion,
    sourceCount: contributors.length,
    missing,
  };
}

/**
 * The agreed observation.
 *
 * Confidence is the wider of what the sources claim and what they actually
 * demonstrate. When three sources each report tight intervals but sit 1.5%
 * apart, their stated precision is contradicted by their disagreement, and
 * the honest uncertainty is the spread.
 */
function buildAnchor(
  feedKey: string,
  target: number,
  contributors: PricePoint[],
  fairPrice: number,
  dispersion: number,
): PricePoint {
  const statedConf = median(contributors.map((p) => p.conf));
  const impliedConf = (dispersion * fairPrice) / 2;
  const closest = contributors.reduce((a, b) =>
    Math.abs(a.publishTime - target) <= Math.abs(b.publishTime - target) ? a : b,
  );

  return {
    value: fairPrice,
    conf: Math.max(statedConf, impliedConf),
    publishTime: closest.publishTime,
    slot: closest.slot,
    source: 'consensus',
    feedId: feedKey,
    // Signed proof belongs to individual observations; the consensus keeps
    // the strongest one so the on-chain check still has bytes to verify.
    raw: contributors.find((p) => p.raw !== null)?.raw ?? null,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] as number;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[mid - 1] as number) + upper) / 2;
}

/** Largest pairwise divergence, relative to the smaller of each pair. Equal
 *  to `(max - min) / min` for positive values. */
export function relativeSpread(values: number[]): number {
  if (values.length < 2) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!(min > 0)) return Infinity;
  return (max - min) / min;
}
