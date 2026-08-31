import { LOCK_PERIODS, canonicalMint } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';
import { DEFAULT_MAX_SKEW_SEC } from '../../utils/pyth.js';
import type { VerificationResult } from '../claim-oracle.js';
import { adjudicateAgentError } from '../agent-error/adjudicate.js';
import { evaluateBreach } from '../agent-error/breach.js';
import {
  AGENT_ERROR_BUNDLE_VERSION,
  type AgentErrorEvidenceBundle,
  type MandateView,
  type OutflowBaselineView,
} from '../agent-error/types.js';
import { analyseAuthorization } from '../exploit/authorization.js';
import { assessLoss } from '../exploit/loss.js';
import { positionFromEnhanced, positionFromRawTx } from '../exploit/position.js';
import { fetchRawTxView } from '../exploit/raw-tx.js';
import { resolveTxTime } from '../oracle/tx-time.js';
import { isSourceUnavailable, type PriceOracle } from '../oracle/types.js';
import { classifyPrograms } from './common.js';
import { verdictConfirmed, verdictIndeterminate, verdictRejected } from './common.js';
import type { SolanaReader } from '../../utils/solana-reader.js';

/**
 * Verifier for `TriggerType.AgentError`.
 *
 * Its whole job is to collect evidence; the judgement lives in the pure
 * {@link adjudicateAgentError}. That split is what makes an agent-error
 * verdict replayable — and this trigger had no bundle at all before, so
 * `recordEvidence` returned early on every claim and a payout on this path was
 * not reproducible even in principle.
 *
 * What it replaced is worth recording, because it is the last surviving copy
 * of a pattern the other three triggers each removed in turn. The previous
 * implementation decided on which programs appeared in the transaction:
 *
 *   - a known DEX → rejected outright as "legitimate trading activity", so a
 *     catastrophic misrouted swap through Jupiter was denied;
 *   - a flash-loan program → confirmed at 0.85;
 *   - a bridge → confirmed at 0.5, so a bridge transfer to the holder's own
 *     address on another chain paid out;
 *   - anything else → confirmed at 0.6, which on devnet is essentially every
 *     program there is;
 *   - a reverted transaction → confirmed at 0.6 on a flat, invented 1 USDC.
 *
 * None of it asked whether the movement was one the holder had authorised in
 * advance, which is the only question this trigger is about.
 */

export interface AgentErrorVerifierOptions {
  /** Chain access. Without it the verdict cannot be established at all: the
   *  decisive question — did the agent's *own* authority move the money —
   *  needs signer flags and token-account owners, and neither is in the
   *  indexer payload. */
  reader?: SolanaReader | null;
  holderAddress?: string;
  /** Mint the mandate's amounts are denominated in. */
  coveredMint?: string;
  /**
   * Reads the holder's declared operating envelope from chain.
   *
   * Returns `null` when no declaration exists — a policy older than the
   * mechanism — which the adjudicator turns into review, never a rejection.
   * Omitting the lookup entirely is different again: that is an outage, and it
   * retries.
   */
  mandate?: () => Promise<MandateView | null>;
  /**
   * Summarises the agent's own outflow history as of the trigger.
   *
   * Takes the window from the mandate, because the cumulative cap has to be
   * measured over the interval the holder declared rather than one this module
   * picked. Context and a confidence input, never a verdict input alone.
   */
  outflowBaseline?: (windowSeconds: number) => Promise<OutflowBaselineView | null>;
  maxSkewSec?: number;
}

export async function verifyAgentError(
  tx: EnhancedTransaction,
  agentAddress: string,
  coverageRaw: number,
  priceOracle: PriceOracle,
  options: AgentErrorVerifierOptions = {},
): Promise<VerificationResult> {
  const lockPeriod = LOCK_PERIODS.AGENT_ERROR;
  const reader = options.reader ?? null;
  const programs = classifyPrograms(tx);

  const bundle: AgentErrorEvidenceBundle = {
    version: AGENT_ERROR_BUNDLE_VERSION,
    stage: 'verify',
    triggerType: 3,
    txSignature: tx.signature,
    agentAddress,
    holderAddress: options.holderAddress,
    coverageRaw,
    coveredMint: options.coveredMint,
    slot: null,
    blockTime: null,
    hasRawTx: false,
    // Audit trail only. The retired verifier's entire decision was built out
    // of this field; it is deliberately not an input to anything now.
    programs: programs as unknown as Record<string, unknown>,
    prices: [],
    windows: {},
    collectedAt: Date.now(),
  };

  // --- the chain's own record ---------------------------------------------
  const view = reader ? await fetchRawTxView(reader, tx.signature) : null;
  bundle.hasRawTx = view !== null;

  // The indexer's shape is still recorded when the chain record is missing:
  // it does not support a verdict, but it is what a reviewer will read.
  bundle.position = view
    ? positionFromRawTx(view, agentAddress)
    : positionFromEnhanced(tx, agentAddress);

  if (!view) {
    return verdictIndeterminate(
      'no_chain_record',
      {
        note:
          'Transaction not resolvable from RPC. Whether the agent’s own authority moved the ' +
          'money cannot be read from the indexer payload, and this verdict rests on it.',
        hasConnection: reader !== null,
      },
      lockPeriod,
      120,
      bundle,
    );
  }

  bundle.authorization = analyseAuthorization({
    view,
    position: bundle.position,
    agentAddress,
    holderAddress: options.holderAddress,
  });

  // --- when did it happen --------------------------------------------------
  const txTime = await resolveTxTime(tx, reader);
  bundle.slot = txTime.slot ?? view.slot;
  bundle.blockTime = txTime.blockTime ?? view.blockTime;
  if (txTime.disagreementSec !== undefined) {
    bundle.blockTimeDisagreementSec = txTime.disagreementSec;
  }

  if (bundle.blockTime === null) {
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

  // --- the declared envelope ------------------------------------------------
  // `undefined` when no lookup was supplied — an outage, which retries.
  // `null` when the lookup ran and found nothing — a policy that predates the
  // mechanism, which goes to a reviewer. The adjudicator tells them apart.
  if (options.mandate) {
    try {
      bundle.mandate = await options.mandate();
    } catch (err) {
      return verdictIndeterminate(
        'mandate_lookup_unavailable',
        { error: err instanceof Error ? err.message : String(err) },
        lockPeriod,
        300,
        bundle,
      );
    }
  }

  // --- what it was worth ---------------------------------------------------
  try {
    const outcome = await assessLoss(bundle.position, {
      oracle: priceOracle,
      blockTime: bundle.blockTime,
      maxSkewSec: options.maxSkewSec ?? DEFAULT_MAX_SKEW_SEC,
      windows: bundle.windows,
      prices: bundle.prices,
    });
    if (outcome.ok) {
      bundle.loss = outcome.assessment;
    } else {
      // Recorded rather than thrown away: the adjudicator turns an absent
      // valuation into `indeterminate`, and a reviewer needs to know which leg
      // could not be priced.
      bundle.programs = {
        ...(bundle.programs ?? {}),
        valuationFailure: { side: outcome.side, ...outcome.failure },
      };
    }
  } catch (err) {
    if (isSourceUnavailable(err)) {
      // A rate-limited price API is not evidence that nothing went wrong.
      return verdictIndeterminate(
        'price_source_unavailable',
        { source: err.source, status: err.status, message: err.message },
        lockPeriod,
        err.retryAfterSec,
        bundle,
      );
    }
    throw err;
  }

  // --- the agent's own history ---------------------------------------------
  // Read after the mandate because the window it is summed over is the
  // mandate's, not one this module chose. A failure here is not fatal: history
  // is corroboration, and the adjudicator scores its absence rather than
  // stalling on it.
  if (options.outflowBaseline && bundle.mandate) {
    try {
      bundle.outflowBaseline = await options.outflowBaseline(bundle.mandate.windowSeconds);
    } catch (err) {
      bundle.outflowBaseline = null;
      bundle.programs = {
        ...(bundle.programs ?? {}),
        outflowBaselineFailure: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- where did it fall against the envelope -------------------------------
  if (bundle.mandate) {
    const covered = options.coveredMint ? canonicalMint(options.coveredMint) : null;
    const coveredLeg = covered
      ? bundle.position.legs.find((leg) => canonicalMint(leg.mint) === covered)
      : undefined;
    const outflowRaw = coveredLeg && coveredLeg.deltaRaw < 0 ? Math.abs(coveredLeg.deltaRaw) : 0;
    const windowOutflowRaw = bundle.outflowBaseline
      ? bundle.outflowBaseline.windowOutflowRaw + outflowRaw
      : null;

    bundle.breach = evaluateBreach({
      mandate: bundle.mandate,
      outflowRaw,
      retainedRaw: coveredLeg?.afterRaw ?? null,
      windowOutflowRaw,
      // Only destinations outside the family. Value landing with the holder or
      // back in the agent is the holder moving their own money, and it is
      // rejected earlier as a self-transfer in any case — but a mandate should
      // never read the agent's own sweep account as an undeclared counterparty.
      destinations: bundle.authorization.foreignDestinations,
      programs: uniqueProgramIds(view),
    });
  }

  // --- judge ---------------------------------------------------------------
  const verdict = adjudicateAgentError(bundle);

  switch (verdict.outcome) {
    case 'confirmed':
      return verdictConfirmed({
        lossAmount: verdict.lossAmount,
        confidence: verdict.confidence,
        details: verdict.details,
        lockPeriod,
        evidence: bundle,
      });
    case 'rejected':
      return verdictRejected(verdict.reason, verdict.details, lockPeriod, bundle);
    default:
      return verdictIndeterminate(
        verdict.reason,
        verdict.details,
        lockPeriod,
        verdict.retryAfterSec,
        bundle,
      );
  }
}

/**
 * Every program the transaction actually invoked, top level and CPI.
 *
 * Read from the chain's own record rather than the indexer payload, because a
 * mandate's program allowlist is about what the value was routed *through* —
 * and a CPI is exactly where a route hides.
 */
function uniqueProgramIds(view: { instructions: Array<{ programId: string }> }): string[] {
  return [...new Set(view.instructions.map((ix) => ix.programId))].sort();
}
