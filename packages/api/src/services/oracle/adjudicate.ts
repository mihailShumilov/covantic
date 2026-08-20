import { CONFIDENCE_CEILING } from '../confidence-lanes.js';
import { lookupMint } from '@covantic/shared';
import { FEED_IDS } from './price-sources/pyth-hermes.js';
import type { EvidenceBundle, PriceWindow } from './types.js';
import type { LegValuation } from './valuation.js';

/**
 * The judgement, separated from the evidence gathering.
 *
 * Nothing in this file performs I/O, reads a clock, or generates randomness.
 * That is the whole reason it exists: a payout nobody can re-derive is a
 * payout nobody can audit, and any hidden input — a live price fetched at
 * scoring time, a `Date.now()` in a threshold — would mean the same evidence
 * produces a different answer tomorrow.
 *
 * The contract is exact: `adjudicate(bundle)` returns the same verdict for
 * the same bundle, forever, for anyone holding it. `pnpm claim:replay` relies
 * on it and the on-chain evidence hash commits to it.
 *
 * When the rules genuinely change, bump {@link ADJUDICATOR_VERSION} rather
 * than quietly altering behaviour. Old claims replayed under a new version
 * are expected to differ; old claims replayed under their own version must
 * not.
 */

/** Bump on any change that alters what this function decides. */
export const ADJUDICATOR_VERSION = '1.0.0';

export type Outcome = 'confirmed' | 'rejected' | 'indeterminate';

export interface Verdict {
  outcome: Outcome;
  lossAmount: number;
  confidence: number;
  reason: string;
  details: Record<string, unknown>;
  retryAfterSec?: number;
}

/** Deviation floor: below this, a gap is routing noise and rounding. */
export const DEVIATION_FLOOR = 0.005;

/** Deviation must clear this multiple of the reference's own uncertainty.
 *  Calling a move manipulation while it sits inside the interval the source
 *  published asserts more precision than the reference has. */
export const CONF_MULTIPLIER = 3;

/**
 * Stand-in for slippage that cannot yet be computed.
 *
 * Honest trading cost includes what the pool's depth charges at this size,
 * which needs reserves at the trade's slot. Until that exists, this floor
 * absorbs the un-modelled part. It drops to {@link DEVIATION_FLOOR} the day
 * depth-implied slippage is subtracted explicitly.
 */
export const SLIPPAGE_UNCERTAINTY_FLOOR = 0.03;

/** Multiple of realised volatility the deviation must also clear. A large gap
 *  in a turbulent window says much less than the same gap in a calm one. */
export const VOLATILITY_MULTIPLIER = 2;

/**
 * Highest confidence reachable here.
 *
 * Below the 0.95 auto-pay lane deliberately. Off-chain agreement, however
 * broad, should not release funds on its own — that is what the on-chain
 * proof path is for.
 */
export { CONFIDENCE_CEILING } from '../confidence-lanes.js';

/** Assumed DEX taker fee where the venue's tier is unknown. Conservative in
 *  the direction that matters: it shrinks the payable loss. */
export const DEFAULT_FEE_BPS = 30;

/**
 * Smallest loss worth paying out, in USDC lamports (0.1 USDC).
 *
 * Percentage thresholds say nothing about absolute size: a trade of a few
 * millionths of a dollar can be 30% off the reference and clear every bar
 * above, then confirm for a single raw lamport. Filing a claim, locking the
 * policy and writing an evidence record all cost more than that is worth.
 */
export const MIN_PAYABLE_LOSS_RAW = 100_000;

/** Exponent the on-chain proof instruction requires. */
const PROOF_EXPO = -8;

/** Inputs the on-chain `verify_and_payout_v2` instruction consumes. */
export interface ProofInputs {
  feedKey: string;
  feedIdHex: string;
  expo: number;
  observedReferencePriceScaled: number;
  executedPriceScaled: number;
  subjectQuantity: number;
  subjectDecimals: number;
  /** Hex Wormhole accumulator update, verifiable by the Pyth receiver. */
  signedUpdateHex: string;
  pricePublishTime: number;
}

/**
 * Score a fully collected evidence bundle.
 *
 * Degrades to `indeterminate` on missing inputs rather than guessing, so an
 * older bundle replayed against a newer adjudicator produces "cannot tell"
 * instead of a confident answer built on absent evidence.
 */
export function adjudicate(bundle: EvidenceBundle): Verdict {
  const execution = bundle.execution;
  const valuation = bundle.valuation;

  if (!execution || !valuation) {
    return indeterminate('incomplete_evidence_bundle', {
      hasExecution: execution !== undefined,
      hasValuation: valuation !== undefined,
      bundleVersion: bundle.version,
    });
  }

  const soldValueUsd = sum(valuation.sold, (l) => l.valueUsd);
  const boughtValueUsd = sum(valuation.bought, (l) => l.valueUsd);
  if (!(soldValueUsd > 0)) {
    return rejected('zero_value_sold', { soldValueUsd, boughtValueUsd });
  }

  const shortfallUsd = soldValueUsd - boughtValueUsd;
  const expectedCostUsd = expectedTradingCostUsd(soldValueUsd);
  const excessLossUsd = shortfallUsd - expectedCostUsd;
  const deviation = shortfallUsd / soldValueUsd;

  const confUsd = sum(valuation.sold, (l) => l.confUsd) + sum(valuation.bought, (l) => l.confUsd);
  const confFraction = confUsd / soldValueUsd;

  const signatures = bundle.signatures ?? null;
  const threshold = Math.max(
    DEVIATION_FLOOR,
    CONF_MULTIPLIER * confFraction,
    VOLATILITY_MULTIPLIER * (signatures?.referenceVolatility ?? 0),
    SLIPPAGE_UNCERTAINTY_FLOOR,
  );

  const subject = pickSubjectLeg(valuation.sold, valuation.bought);
  const impliedSubjectPrice = subject
    ? (subject.side === 'bought' ? soldValueUsd : boughtValueUsd) / subject.leg.amountUi
    : null;
  const proof = buildProofInputs(subject, impliedSubjectPrice, bundle);

  const parFallbackUsed = [...valuation.sold, ...valuation.bought].some((l) => l.parFallback);
  const facts = {
    deviation,
    threshold,
    soldValueUsd,
    boughtValueUsd,
    shortfallUsd,
    expectedCostUsd,
    excessLossUsd,
    referenceConfUsd: confUsd,
    referenceConfFraction: confFraction,
    blockTime: bundle.blockTime,
    slot: bundle.slot,
    sold: describeLegs(valuation.sold),
    bought: describeLegs(valuation.bought),
    maxSkewSec: maxWindowSkew(bundle.windows),
    parFallbackUsed,
    hasSignedProof: bundle.prices.some((p) => p.raw !== null),
    consensus: summariseConsensus(bundle.windows),
    signatures: signatures
      ? {
          present: signatures.present,
          score: signatures.score,
          unevaluated: signatures.unevaluated,
          referenceVolatility: signatures.referenceVolatility,
          referenceDriftRatio: signatures.referenceDriftRatio,
        }
      : null,
  };

  if (deviation < threshold) return rejected('deviation_below_threshold', facts);
  if (excessLossUsd <= 0) return rejected('within_expected_trading_cost', facts);

  const lossAmount = capToCoverage(uiToRaw(excessLossUsd), bundle.coverageRaw);
  if (lossAmount < MIN_PAYABLE_LOSS_RAW) {
    return rejected('loss_below_dust', { ...facts, lossAmount, floor: MIN_PAYABLE_LOSS_RAW });
  }

  // A bad price is not an attack without a shape to go with it. Nothing
  // observed means either it was not manipulation or the evidence was not
  // visible — both belong with a reviewer.
  if (!signatures || signatures.present.length === 0) {
    return indeterminate(
      'no_manipulation_signature',
      {
        ...facts,
        note:
          'Fill is well off an agreed reference, but nothing distinguishes it from ordinary ' +
          'bad execution. Escalating rather than paying or denying.',
      },
      1_800,
    );
  }

  return {
    outcome: 'confirmed',
    lossAmount,
    confidence: scoreConfidence(deviation, threshold, bundle, parFallbackUsed),
    reason: 'price_deviation',
    details: {
      reason: 'price_deviation',
      ...facts,
      agentRole: inferRole(valuation.sold),
      proof,
    },
  };
}

/**
 * What this trade would have cost on an honest venue.
 *
 * Subtracting it is the difference between "the agent was robbed" and "the
 * agent traded". Fee-only for now, which under-estimates honest cost and so
 * biases the loss upward — a known bias rather than a surprise.
 */
export function expectedTradingCostUsd(soldValueUsd: number, feeBps = DEFAULT_FEE_BPS): number {
  if (!(soldValueUsd > 0)) return 0;
  return (soldValueUsd * feeBps) / 10_000;
}

/**
 * Confidence in the verdict, not in the price.
 *
 * The budget is lopsided on purpose: how far the price was off contributes at
 * most 0.10, while corroboration and structural evidence together contribute
 * up to 0.30. A huge deviation from one lonely feed should not outrank a
 * modest one that four independent sources and a manipulation signature all
 * agree on.
 */
function scoreConfidence(
  deviation: number,
  threshold: number,
  bundle: EvidenceBundle,
  parFallbackUsed: boolean,
): number {
  let confidence = 0.5;

  const excess = (deviation - threshold) / Math.max(threshold, 1e-9);
  confidence += Math.min(excess, 3) * 0.0333;

  const windows = Object.values(bundle.windows);
  if (
    windows.some((w) => w.contributors === undefined && (w.before === null || w.after === null))
  ) {
    confidence -= 0.05;
  }

  const consensus = summariseConsensus(bundle.windows);
  if (consensus.minSourceCount >= 4) confidence += 0.05;
  else if (consensus.minSourceCount <= 1) confidence -= 0.15;
  confidence -= Math.min(0.1, consensus.maxDispersion * 2);

  const skew = maxWindowSkew(bundle.windows);
  if (skew > 0) confidence -= Math.min(0.06, 0.002 * skew);
  if (bundle.prices.some((p) => p.raw === null)) confidence -= 0.03;
  if (parFallbackUsed) confidence -= 0.03;
  if (bundle.blockTimeDisagreementSec !== undefined && bundle.blockTimeDisagreementSec > 2) {
    confidence -= 0.05;
  }

  const signatures = bundle.signatures;
  confidence += Math.min(0.25, (signatures?.score ?? 0) * 0.35);
  confidence -= Math.min(0.1, (signatures?.unevaluated.length ?? 0) * 0.02);

  return Math.max(0, Math.min(CONFIDENCE_CEILING, Number(confidence.toFixed(4))));
}

/**
 * Inputs the on-chain proof instruction needs, or null when this claim cannot
 * be settled that way.
 *
 * The signed Wormhole update is load-bearing: without those bytes the chain
 * has nothing to verify. Everything is scaled to Pyth's 1e-8 exponent so the
 * program never rescales — a mismatched exponent is the classic way to be
 * wrong by eight orders of magnitude.
 */
function buildProofInputs(
  subject: { leg: LegValuation; side: 'sold' | 'bought' } | null,
  impliedPrice: number | null,
  bundle: EvidenceBundle,
): ProofInputs | null {
  if (!subject || impliedPrice === null || !subject.leg.feedKey) return null;

  const feedIdHex = FEED_IDS[subject.leg.feedKey];
  if (!feedIdHex) return null;

  // Only Pyth observations carry a guardian signature; exchange references
  // are unsigned REST responses and cannot be proven on chain.
  const signed = bundle.prices.find((p) => p.source === 'pyth' && p.feedId === feedIdHex && p.raw);
  if (!signed?.raw) return null;

  const subjectDecimals = lookupMint(subject.leg.mint)?.decimals;
  if (subjectDecimals === undefined) return null;

  return {
    feedKey: subject.leg.feedKey,
    feedIdHex,
    expo: PROOF_EXPO,
    // The chain reads the reference out of the signed update itself. Recorded
    // here only so a mismatch between what we saw and what the guardians
    // signed shows up in the audit trail.
    observedReferencePriceScaled: Math.round(signed.value * 10 ** -PROOF_EXPO),
    executedPriceScaled: Math.round(impliedPrice * 10 ** -PROOF_EXPO),
    subjectQuantity: Math.round(subject.leg.amountUi * 10 ** subjectDecimals),
    subjectDecimals,
    signedUpdateHex: signed.raw,
    pricePublishTime: signed.publishTime,
  };
}

/**
 * The leg whose price the manipulation would have moved: the largest
 * non-stable position by value. Running the structural checks against a
 * stablecoin feed would test the wrong thing entirely.
 */
export function pickSubjectLeg(
  soldLegs: LegValuation[],
  boughtLegs: LegValuation[],
): { leg: LegValuation; side: 'sold' | 'bought' } | null {
  const candidates: Array<{ leg: LegValuation; side: 'sold' | 'bought' }> = [
    ...soldLegs.map((leg) => ({ leg, side: 'sold' as const })),
    ...boughtLegs.map((leg) => ({ leg, side: 'bought' as const })),
  ].filter((c) => !c.leg.parFallback && c.leg.feedKey !== null && c.leg.amountUi > 0);

  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.leg.valueUsd >= b.leg.valueUsd ? a : b));
}

/** How well corroborated the weakest leg was, plus the widest disagreement.
 *  The weakest leg is what matters: a verdict is only as well-supported as
 *  its least-supported input. */
export function summariseConsensus(windows: Record<string, PriceWindow>) {
  const all = Object.values(windows);
  if (all.length === 0) return { minSourceCount: 0, maxDispersion: 0, bySources: {} };
  return {
    minSourceCount: Math.min(...all.map((w) => w.sourceCount ?? 1)),
    maxDispersion: Math.max(...all.map((w) => w.dispersion ?? 0)),
    bySources: Object.fromEntries(
      all.map((w) => [
        w.feedId,
        {
          sourceCount: w.sourceCount ?? 1,
          dispersion: w.dispersion ?? 0,
          contributors: w.contributors?.map((c) => c.source) ?? [w.anchor.source],
          missing: w.missing ?? [],
        },
      ]),
    ),
  };
}

function maxWindowSkew(windows: Record<string, PriceWindow>): number {
  return Object.values(windows).reduce((max, w) => Math.max(max, w.skewSec), 0);
}

function describeLegs(legs: LegValuation[]) {
  return legs.map((l) => ({
    mint: l.mint,
    symbol: l.symbol,
    amountUi: l.amountUi,
    priceUsd: l.priceUsd,
    valueUsd: l.valueUsd,
    feedKey: l.feedKey,
    source: l.source,
    parFallback: l.parFallback,
  }));
}

/** Buyer when the agent handed over stables, seller when it handed over the
 *  priced asset. Descriptive only — the valuation is symmetric. */
function inferRole(soldLegs: LegValuation[]): 'buyer' | 'seller' | 'unknown' {
  if (soldLegs.length === 0) return 'unknown';
  const allPar = soldLegs.every((l) => l.parFallback || l.feedKey?.startsWith('USD'));
  return allPar ? 'buyer' : 'seller';
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function uiToRaw(ui: number): number {
  return Math.round(ui * 1_000_000);
}

function capToCoverage(lossRaw: number, coverageRaw: number): number {
  if (lossRaw <= 0) return 0;
  return Math.min(Math.floor(lossRaw), coverageRaw);
}

function rejected(reason: string, details: Record<string, unknown>): Verdict {
  return {
    outcome: 'rejected',
    lossAmount: 0,
    confidence: 0,
    reason,
    details: { reason, ...details },
  };
}

function indeterminate(
  reason: string,
  details: Record<string, unknown>,
  retryAfterSec = 600,
): Verdict {
  return {
    outcome: 'indeterminate',
    lossAmount: 0,
    confidence: 0,
    reason,
    details: { reason, ...details },
    retryAfterSec,
  };
}
