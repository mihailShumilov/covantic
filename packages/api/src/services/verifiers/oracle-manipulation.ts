import { LOCK_PERIODS } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';
import type { SolanaReader } from '../../utils/solana-reader.js';
import { DEFAULT_MAX_SKEW_SEC } from '../../utils/pyth.js';
import type { VerificationResult } from '../claim-oracle.js';
import {
  ADJUDICATOR_VERSION,
  adjudicate,
  pickSubjectLeg,
  type ProofInputs,
  type Verdict,
} from '../oracle/adjudicate.js';
import { reconstructExecution, type ExecutionSummary } from '../oracle/execution.js';
import { bundleHash } from '../oracle/hash.js';
import { collectSignatures } from '../oracle/signatures.js';
import { resolveTxTime } from '../oracle/tx-time.js';
import { isSourceUnavailable, type EvidenceBundle, type PriceOracle } from '../oracle/types.js';
import { valueLegs, type ValuationFailure } from '../oracle/valuation.js';
import {
  classifyPrograms,
  verdictConfirmed,
  verdictIndeterminate,
  verdictRejected,
} from './common.js';

/** Bundle schema version. Bump whenever the evidence shape changes so an old
 *  bundle replayed against a new adjudicator is recognisably old. */
export const BUNDLE_VERSION = '1.4.0';

export interface OracleVerifierOptions {
  /** Chain access for the block-time cross-check. */
  reader?: SolanaReader | null;
  /** Override the price/block-time agreement tolerance, seconds. */
  maxSkewSec?: number;
}

/**
 * Verifier for TriggerType.OracleManipulation.
 *
 * Approves when the agent's net position change in the trigger transaction is
 * worth measurably less than what it gave up, priced against the reference
 * **at that transaction's block time**, after subtracting what an honest
 * trade would have cost anyway.
 *
 * Four things this rests on, each of which used to be wrong:
 *
 *   1. *When.* Comparing a historical swap against a live spot price measures
 *      market drift since execution, not the fill. Every price read here goes
 *      through `getPriceWindow(feed, blockTime)`.
 *   2. *What.* The position change comes from netted balance deltas, not from
 *      picking the two largest transfers — which mis-reads multi-hop routes,
 *      split fills, and wSOL wrapping as trades between unrelated legs.
 *   3. *How much.* Both sides are valued independently, so any registered
 *      pair can be compared, and the DEX fee is subtracted before anything is
 *      called a loss.
 *
 * Remaining phase boundaries, stated so the current limits are explicit:
 *   4. *Against what.* The reference is a consensus of independent sources,
 *      not one feed. Adjudicating manipulation of a feed using only that feed
 *      lets the attacker's price certify itself.
 *
 * Remaining phase boundary, stated so the current limit is explicit: no
 * structural manipulation signature is required yet (Phase 4 — reversion,
 * same-slot displacement, sandwich pattern, flash-loan co-occurrence). Until
 * that lands, a confirmed verdict means "filled well off an agreed reference",
 * which is strong but still not proof of an attack, so the confidence ceiling
 * here stays below the auto-pay lane.
 */
export async function verifyOracleManipulation(
  tx: EnhancedTransaction,
  agentAddress: string,
  coverageRaw: number,
  oracle: PriceOracle,
  options: OracleVerifierOptions = {},
): Promise<VerificationResult> {
  const lockPeriod = LOCK_PERIODS.ORACLE_MANIPULATION;
  const maxSkewSec = options.maxSkewSec ?? DEFAULT_MAX_SKEW_SEC;
  const programs = classifyPrograms(tx);

  const bundle: EvidenceBundle = {
    version: BUNDLE_VERSION,
    stage: 'verify',
    triggerType: 2,
    txSignature: tx.signature,
    agentAddress,
    coverageRaw,
    slot: null,
    blockTime: null,
    prices: [],
    windows: {},
    collectedAt: Date.now(),
  };

  // --- what actually happened to the agent's balance sheet -----------------
  // Reconstructed before any branching so every outcome, including the ones
  // that stop here, carries the position change into the evidence.
  const execution = reconstructExecution(tx, agentAddress);
  bundle.execution = execution;

  if (!programs.dex) {
    if (programs.lending) {
      // A lending or perpetuals venue read an oracle to value collateral or
      // mark a position. This is the canonical oracle attack — inflate a
      // price, borrow against it, walk away — and it never looks like a
      // mispriced swap, because no swap happens. The swap-shaped analysis
      // below cannot score it, and quantifying the loss needs the protocol's
      // own accounting, so it goes to an adjuster instead of being denied for
      // failing to be a trade.
      return verdictIndeterminate(
        'lending_oracle_exposure',
        {
          programs,
          execution,
          note:
            'Collateral or mark price was read from an oracle by a lending/perp program. ' +
            'Protocol-specific accounting is needed to quantify the loss.',
        },
        lockPeriod,
        3_600,
        bundle,
      );
    }
    return verdictRejected(
      'no_dex_interaction',
      { programs, note: 'OracleManipulation requires a DEX swap in the transaction.' },
      lockPeriod,
      bundle,
    );
  }

  switch (execution.shape) {
    case 'no_position_change':
      return verdictRejected(
        'no_position_change',
        { execution, note: execution.note },
        lockPeriod,
        bundle,
      );
    case 'no_swap':
      return verdictRejected(
        'incomplete_swap',
        { execution, note: execution.note },
        lockPeriod,
        bundle,
      );
    case 'unsupported_shape':
      // Several mints on both sides. There is a real trade here, we just
      // cannot reduce it to one implied price — a reviewer can, so this goes
      // to review rather than being denied.
      return verdictIndeterminate(
        'unsupported_swap_shape',
        { execution, note: execution.note },
        lockPeriod,
        3_600,
        bundle,
      );
    default:
      break;
  }

  // --- when did it happen --------------------------------------------------
  const txTime = await resolveTxTime(tx, options.reader ?? null);
  bundle.slot = txTime.slot;
  bundle.blockTime = txTime.blockTime;
  if (txTime.disagreementSec !== undefined) {
    bundle.blockTimeDisagreementSec = txTime.disagreementSec;
  }

  if (txTime.blockTime === null) {
    return verdictIndeterminate(
      'no_block_time',
      {
        note: 'Could not establish when the transaction executed; refusing to price against now.',
        heliusTimestamp: tx.timestamp ?? null,
      },
      lockPeriod,
      60,
      bundle,
    );
  }

  // --- what it was worth ---------------------------------------------------
  const ctx = {
    oracle,
    blockTime: txTime.blockTime,
    maxSkewSec,
    windows: bundle.windows,
    prices: bundle.prices,
  };

  let soldValuation;
  let boughtValuation;
  try {
    soldValuation = await valueLegs(execution.sold, ctx);
    boughtValuation = await valueLegs(execution.bought, ctx);
  } catch (err) {
    if (isSourceUnavailable(err)) {
      return verdictIndeterminate(
        'price_source_unavailable',
        {
          source: err.source,
          status: err.status ?? null,
          note: 'Reference source unreachable — retrying; this is not a denial.',
        },
        lockPeriod,
        err.retryAfterSec,
        bundle,
      );
    }
    throw err;
  }

  bundle.prices.sort((a, b) => a.publishTime - b.publishTime);

  if (!soldValuation.ok) return valuationFailed(soldValuation.failure, lockPeriod, bundle);
  if (!boughtValuation.ok) return valuationFailed(boughtValuation.failure, lockPeriod, bundle);

  bundle.valuation = { sold: soldValuation.legs, bought: boughtValuation.legs };

  // --- structural evidence -------------------------------------------------
  // Collected, not judged: whether these signatures are enough is the
  // adjudicator's call, and it must be able to make it again later from the
  // bundle alone.
  const soldValueUsd = soldValuation.legs.reduce((t, l) => t + l.valueUsd, 0);
  const boughtValueUsd = boughtValuation.legs.reduce((t, l) => t + l.valueUsd, 0);
  const subject = pickSubjectLeg(soldValuation.legs, boughtValuation.legs);

  if (subject && soldValueUsd > 0) {
    const otherSideUsd = subject.side === 'bought' ? soldValueUsd : boughtValueUsd;
    bundle.signatures = await collectSignatures({
      tx,
      programs,
      blockTime: txTime.blockTime,
      slot: txTime.slot,
      oracle,
      agentAddress,
      subjectFeedKey: subject.leg.feedKey as string,
      impliedPrice: otherSideUsd / subject.leg.amountUi,
      referencePrice: subject.leg.priceUsd,
      referenceDispersion: subject.leg.dispersion ?? 0,
      referenceConfFraction: subject.leg.confPerUnitUsd / subject.leg.priceUsd,
      reader: options.reader ?? null,
    });
  }

  // --- judgement -----------------------------------------------------------
  // Everything above gathered evidence; nothing below touches the network.
  return toVerificationResult(adjudicate(bundle), lockPeriod, bundle);
}

/**
 * Wrap a pure verdict in the shape the claim pipeline consumes.
 *
 * The lock period and the bundle are pipeline concerns, not judgement ones —
 * keeping them out of the adjudicator is what lets a stored bundle be
 * replayed with no pipeline around it.
 */
function toVerificationResult(
  verdict: Verdict,
  lockPeriod: number,
  bundle: EvidenceBundle,
): VerificationResult {
  const details = {
    ...verdict.details,
    adjudicatorVersion: ADJUDICATOR_VERSION,
    bundleHash: bundleHash(bundle as unknown as Record<string, unknown>),
  };

  switch (verdict.outcome) {
    case 'confirmed':
      return verdictConfirmed({
        lossAmount: verdict.lossAmount,
        confidence: verdict.confidence,
        details,
        lockPeriod,
        evidence: bundle,
      });
    case 'indeterminate':
      return verdictIndeterminate(
        verdict.reason,
        details,
        lockPeriod,
        verdict.retryAfterSec ?? 600,
        bundle,
      );
    default:
      return verdictRejected(verdict.reason, details, lockPeriod, bundle);
  }
}

function valuationFailed(
  failure: ValuationFailure,
  lockPeriod: number,
  bundle: EvidenceBundle,
): VerificationResult {
  // Every one of these is a gap on our side — an unregistered mint, a silent
  // feed, a stalled sample. None is a finding about the trade, so none of
  // them may close the claim.
  switch (failure.kind) {
    case 'no_feed':
      return verdictIndeterminate(
        'no_price_feed_for_mint',
        {
          pricedMint: failure.mint,
          note: 'No reference feed registered for this mint — cannot score deviation.',
        },
        lockPeriod,
        3_600,
        bundle,
      );
    case 'no_sample':
      return verdictIndeterminate(
        'no_price_at_block_time',
        { pricedMint: failure.mint, feedKey: failure.feedKey },
        lockPeriod,
        300,
        bundle,
      );
    case 'stale':
      return verdictIndeterminate(
        'price_too_far_from_block_time',
        { pricedMint: failure.mint, feedKey: failure.feedKey, skewSec: failure.skewSec },
        lockPeriod,
        300,
        bundle,
      );
    case 'insufficient_sources':
      // Too few independent references to rule out that the one we have is
      // the manipulated one.
      return verdictIndeterminate(
        'insufficient_price_sources',
        {
          pricedMint: failure.mint,
          feedKey: failure.feedKey,
          sourceCount: failure.sourceCount,
          required: failure.required,
          note: 'Cannot corroborate the reference; a lone source may be the manipulated one.',
        },
        lockPeriod,
        600,
        bundle,
      );
    case 'sources_disagree':
      return verdictIndeterminate(
        'price_sources_disagree',
        {
          pricedMint: failure.mint,
          feedKey: failure.feedKey,
          dispersion: failure.dispersion,
          limit: failure.limit,
          note: 'References contradict each other; a median of disagreeing inputs is not evidence.',
        },
        lockPeriod,
        600,
        bundle,
      );
  }
}

export type { ExecutionSummary, ProofInputs };
