import { lookupMint } from '@covantic/shared';
import type { NetDelta } from './execution.js';
import type { PriceOracle, PricePoint, PriceSourceId, PriceWindow } from './types.js';

/** Assumed DEX taker fee when the venue's actual tier is not known.
 *
 *  30 bps is the common Solana AMM tier and sits above most Jupiter routes,
 *  so assuming it is conservative in the direction that matters: it shrinks
 *  the payable loss rather than inflating it. Phase 4 replaces this with the
 *  pool's real fee tier once slot-indexed pool state is available. */
export const DEFAULT_FEE_BPS = 30;

/** Uncertainty attached to a stable priced at par because its feed had no
 *  sample at the block time. Half a percent is wide enough that a marginal
 *  "loss" resting entirely on the par assumption cannot clear the bar. */
const PAR_FALLBACK_CONF = 0.005;

/** Outer bound on how far a consensus sample may sit from the block time.
 *
 *  The coarsest source is a one-minute exchange candle dated at its midpoint,
 *  so 30s is the largest legitimate skew; 90 leaves room for clock slop while
 *  still catching a window that was assembled from genuinely stale data. */
const CONSENSUS_MAX_SKEW_SEC = 90;

export interface LegValuation {
  mint: string;
  symbol: string;
  amountUi: number;
  /** Reference price per unit, USD. */
  priceUsd: number;
  /** Reference uncertainty per unit, USD. */
  confPerUnitUsd: number;
  valueUsd: number;
  confUsd: number;
  feedKey: string | null;
  source: PriceSourceId | 'par';
  /** True when the price came from the stable par assumption, not a feed. */
  parFallback: boolean;
  /** Independent sources that agreed on this price. */
  sourceCount?: number;
  /** Relative spread between those sources. */
  dispersion?: number;
  contributors?: PriceSourceId[];
}

export type ValuationFailure =
  | { kind: 'no_feed'; mint: string }
  | { kind: 'no_sample'; mint: string; feedKey: string }
  | { kind: 'stale'; mint: string; feedKey: string; skewSec: number }
  | { kind: 'insufficient_sources'; mint: string; feedKey: string; sourceCount: number; required: number }
  | { kind: 'sources_disagree'; mint: string; feedKey: string; dispersion: number; limit: number };

/**
 * How much agreement a leg needs before its price may support a finding.
 *
 * Split by token kind on purpose. The priced leg is where a manipulation
 * shows up, so it has to be corroborated by references that cannot be moved
 * by the same action. A stablecoin leg is a different problem: its par value
 * is a strong prior, and demanding three exchange listings for devnet USDC
 * would send every ordinary claim to review for no gain in certainty.
 */
export interface ValuationPolicy {
  minSourcesPriced: number;
  minSourcesStable: number;
  maxDispersion: number;
}

export const DEFAULT_VALUATION_POLICY: ValuationPolicy = {
  minSourcesPriced: 3,
  minSourcesStable: 1,
  maxDispersion: 0.02,
};

export type ValuationOutcome =
  | { ok: true; legs: LegValuation[]; totalUsd: number; confUsd: number }
  | { ok: false; failure: ValuationFailure };

export interface ValuationContext {
  oracle: PriceOracle;
  /** Block time of the trigger transaction. Every price is read at this
   *  instant; there is no such thing as "the price" without it. */
  blockTime: number;
  maxSkewSec: number;
  policy?: ValuationPolicy;
  /** Accumulators the caller folds into the evidence bundle. */
  windows: Record<string, PriceWindow>;
  prices: PricePoint[];
}

/**
 * Value a set of position deltas in USD at the transaction's block time.
 *
 * Valuing *both* sides is what removes the old "one leg must be USDC"
 * restriction. Any pair whose mints are both registered can be compared, and
 * an execution shortfall becomes a plain statement: value handed over minus
 * value received.
 *
 * Propagates {@link PriceSourceUnavailableError} — an outage is the caller's
 * problem to turn into a retry, not something to paper over with a guess.
 */
export async function valueLegs(
  deltas: NetDelta[],
  ctx: ValuationContext,
): Promise<ValuationOutcome> {
  const legs: LegValuation[] = [];
  const policy = ctx.policy ?? DEFAULT_VALUATION_POLICY;

  for (const delta of deltas) {
    const meta = lookupMint(delta.mint);
    if (!meta) return { ok: false, failure: { kind: 'no_feed', mint: delta.mint } };

    if (!meta.feedKey) {
      if (meta.kind !== 'stable') {
        return { ok: false, failure: { kind: 'no_feed', mint: delta.mint } };
      }
      legs.push(parLeg(delta, meta.symbol));
      continue;
    }

    const window = await ctx.oracle.getPriceWindow(meta.feedKey, ctx.blockTime, ctx.maxSkewSec);

    if (!window) {
      // A stable with no sample can fall back to par; anything else cannot be
      // guessed at, and guessing is how a fabricated deviation gets paid.
      if (meta.kind === 'stable') {
        legs.push(parLeg(delta, meta.symbol));
        continue;
      }
      return { ok: false, failure: { kind: 'no_sample', mint: delta.mint, feedKey: meta.feedKey } };
    }

    ctx.windows[`${window.source}:${window.feedId}`] = window;
    // Keep every underlying observation, not just the agreed value — the
    // individual samples are what a replay re-derives the consensus from.
    for (const point of [window.before, window.after, ...(window.contributors ?? [])]) {
      if (point && !ctx.prices.some((p) => sameSample(p, point))) ctx.prices.push(point);
    }

    // Consensus windows have already held each source to its own resolution,
    // so re-applying the tightest tolerance here would reject a perfectly
    // good exchange candle for being minute-grained. They still get an outer
    // bound: the valuation must not simply trust that whoever built the
    // consensus did the filtering.
    const isConsensus = window.contributors !== undefined;
    const skewLimit = isConsensus
      ? Math.max(ctx.maxSkewSec, CONSENSUS_MAX_SKEW_SEC)
      : ctx.maxSkewSec;
    if (window.skewSec > skewLimit) {
      return {
        ok: false,
        failure: {
          kind: 'stale',
          mint: delta.mint,
          feedKey: meta.feedKey,
          skewSec: window.skewSec,
        },
      };
    }

    const anchor = window.anchor;
    if (!(anchor.value > 0)) {
      return { ok: false, failure: { kind: 'no_sample', mint: delta.mint, feedKey: meta.feedKey } };
    }

    // A single-source window reports no count; treat it as the one source it
    // is rather than assuming the policy was satisfied.
    const sourceCount = window.sourceCount ?? 1;
    const dispersion = window.dispersion ?? 0;
    const required = meta.kind === 'stable' ? policy.minSourcesStable : policy.minSourcesPriced;

    if (sourceCount < required) {
      // Par is a defensible prior for a stable; there is no equivalent prior
      // for a priced asset, and inventing one is how a manipulated feed ends
      // up certifying itself.
      if (meta.kind === 'stable') {
        legs.push(parLeg(delta, meta.symbol));
        continue;
      }
      return {
        ok: false,
        failure: {
          kind: 'insufficient_sources',
          mint: delta.mint,
          feedKey: meta.feedKey,
          sourceCount,
          required,
        },
      };
    }

    if (dispersion > policy.maxDispersion) {
      // The references contradict each other. One of them is probably the
      // manipulated one — but knowing that is not the same as knowing which,
      // and a median of disagreeing inputs is not evidence.
      return {
        ok: false,
        failure: {
          kind: 'sources_disagree',
          mint: delta.mint,
          feedKey: meta.feedKey,
          dispersion,
          limit: policy.maxDispersion,
        },
      };
    }

    legs.push({
      mint: delta.mint,
      symbol: meta.symbol,
      amountUi: delta.amountUi,
      priceUsd: anchor.value,
      confPerUnitUsd: anchor.conf,
      valueUsd: delta.amountUi * anchor.value,
      confUsd: delta.amountUi * anchor.conf,
      feedKey: meta.feedKey,
      source: anchor.source,
      parFallback: false,
      sourceCount,
      dispersion,
      contributors: window.contributors?.map((c) => c.source),
    });
  }

  return {
    ok: true,
    legs,
    totalUsd: legs.reduce((sum, l) => sum + l.valueUsd, 0),
    // Linear rather than quadratic: correlated feed errors are the realistic
    // case, and summing keeps the uncertainty band on the wide side.
    confUsd: legs.reduce((sum, l) => sum + l.confUsd, 0),
  };
}

/**
 * What this trade would have cost on an honest venue.
 *
 * Subtracting it is the difference between "the agent was robbed" and "the
 * agent traded". A vault that reimburses the ordinary fee on every flagged
 * swap is paying out for normal market friction.
 *
 * Depth-implied slippage is the other half of this and needs pool reserves at
 * the trade's slot, which arrives with the pool-state source in Phase 4.
 * Until then this is fee-only and therefore an *under*-estimate of honest
 * cost, which biases the loss upward — flagged here so the bias is a known
 * quantity rather than a surprise.
 */
export function expectedTradingCostUsd(soldValueUsd: number, feeBps = DEFAULT_FEE_BPS): number {
  if (!(soldValueUsd > 0)) return 0;
  return (soldValueUsd * feeBps) / 10_000;
}

function parLeg(delta: NetDelta, symbol: string): LegValuation {
  return {
    mint: delta.mint,
    symbol,
    amountUi: delta.amountUi,
    priceUsd: 1,
    confPerUnitUsd: PAR_FALLBACK_CONF,
    valueUsd: delta.amountUi,
    confUsd: delta.amountUi * PAR_FALLBACK_CONF,
    feedKey: null,
    source: 'par',
    parFallback: true,
  };
}

function sameSample(a: PricePoint, b: PricePoint): boolean {
  return a.source === b.source && a.feedId === b.feedId && a.publishTime === b.publishTime;
}
