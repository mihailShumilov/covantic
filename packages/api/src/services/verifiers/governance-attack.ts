import { LOCK_PERIODS } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';
import { DEFAULT_MAX_SKEW_SEC } from '../../utils/pyth.js';
import type { VerificationResult } from '../claim-oracle.js';
import type { BalanceReading } from '../exploit/baseline.js';
import type { BalanceBaseline } from '../exploit/prefilter.js';
import { fetchRawTxView } from '../exploit/raw-tx.js';
import type { CohortLookup } from '../exploit/signatures.js';
import { analyseAuthority } from '../governance/authority.js';
import { adjudicateGovernance } from '../governance/adjudicate.js';
import { assessGovernanceExposure } from '../governance/conjunction.js';
import { collectGovernanceSignatures } from '../governance/signatures.js';
import {
  GOVERNANCE_BUNDLE_VERSION,
  type GovernanceBaselineView,
  type GovernanceEvidenceBundle,
} from '../governance/types.js';
import { resolveTxTime } from '../oracle/tx-time.js';
import { isSourceUnavailable, type PriceOracle } from '../oracle/types.js';
import { classifyPrograms } from './common.js';
import { verdictConfirmed, verdictIndeterminate, verdictRejected } from './common.js';
import type { SolanaReader } from '../../utils/solana-reader.js';

/**
 * Verifier for `TriggerType.GovernanceAttack`.
 *
 * Its whole job is to collect evidence; the judgement lives in the pure
 * {@link adjudicateGovernance}. That split is what makes a governance verdict
 * replayable, and it is why this file performs every network call up front
 * and then stops reasoning.
 *
 * What it replaced is worth recording. The previous implementation decided on
 * which programs appeared in the transaction: it rejected unless SPL
 * Governance or Metadao was invoked, and otherwise confirmed at 50% of
 * coverage if any balance had moved by more than 0.01 SOL. The covered
 * subject is an agent wallet, so the first rule denied every real takeover —
 * a `SetAuthority` against the agent's own accounts touches no DAO program —
 * while the second paid out on routine DAO votes. Neither rule ever asked who
 * controlled the agent's accounts, which is the only question this trigger is
 * about.
 */

/**
 * The lookups this verifier needs but must not perform itself.
 *
 * Injected rather than imported so the module stays free of database and
 * program coupling, and so a corpus test can drive it without either.
 */
export interface GovernanceVerifierOptions {
  /** Chain access. Without it the verdict cannot be established at all. */
  reader?: SolanaReader | null;
  holderAddress?: string;
  /**
   * Reads the holder's declared authority set from chain.
   *
   * Returns `null` when no declaration exists — a policy older than the
   * mechanism — which the adjudicator turns into review, never a rejection.
   * Omitting the lookup entirely is different again: that is an outage, and
   * it retries.
   */
  baseline?: () => Promise<GovernanceBaselineView | null>;
  /** What the agent held before the takeover, from the snapshot table. */
  holdingsBefore?: (at: number) => Promise<{ holdings: BalanceBaseline; blockTime: number | null }>;
  /**
   * What the agent holds now, what of it is frozen, and when the reading was
   * taken.
   *
   * The timestamp comes from the reader rather than a clock inside this
   * module on purpose: it is one operand of the interval the exposure is
   * measured over, and an operand read out of the ambient environment is one
   * a replay cannot reproduce and a test cannot control.
   */
  holdingsNow?: () => Promise<{
    holdings: BalanceReading[];
    frozen: BalanceReading[];
    blockTime: number;
  }>;
  /** Finds other insured agents taken over by the same key in the window. */
  cohort?: CohortLookup;
  maxSkewSec?: number;
}

export async function verifyGovernanceAttack(
  tx: EnhancedTransaction,
  agentAddress: string,
  coverageRaw: number,
  priceOracle: PriceOracle,
  options: GovernanceVerifierOptions = {},
): Promise<VerificationResult> {
  const lockPeriod = LOCK_PERIODS.GOVERNANCE_ATTACK;
  const reader = options.reader ?? null;
  const programs = classifyPrograms(tx);

  const bundle: GovernanceEvidenceBundle = {
    version: GOVERNANCE_BUNDLE_VERSION,
    stage: 'verify',
    triggerType: 4,
    txSignature: tx.signature,
    agentAddress,
    holderAddress: options.holderAddress,
    coverageRaw,
    slot: null,
    blockTime: null,
    hasRawTx: false,
    // Audit trail only. The old verifier's entire decision was built out of
    // this field; it is deliberately not an input to anything now.
    programs: programs as unknown as Record<string, unknown>,
    prices: [],
    windows: {},
    collectedAt: Date.now(),
  };

  // --- the chain's own record ---------------------------------------------
  const view = reader ? await fetchRawTxView(reader, tx.signature) : null;
  bundle.hasRawTx = view !== null;

  if (!view) {
    return verdictIndeterminate(
      'no_chain_record',
      {
        note:
          'Transaction not resolvable from RPC. Signer flags and per-side token account ' +
          'owners live only there, and this verdict rests on both.',
        hasConnection: reader !== null,
      },
      lockPeriod,
      120,
      bundle,
    );
  }

  bundle.authority = analyseAuthority({
    view,
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
        note: 'Could not establish when control changed hands; refusing to price against now.',
        heliusTimestamp: tx.timestamp ?? null,
      },
      lockPeriod,
      60,
      bundle,
    );
  }
  const takeoverBlockTime = bundle.blockTime;

  // --- the declared set ----------------------------------------------------
  // `undefined` when no lookup was supplied — an outage, which retries.
  // `null` when the lookup ran and found nothing — a policy that predates the
  // mechanism, which goes to a reviewer. The adjudicator tells them apart.
  if (options.baseline) {
    try {
      bundle.baseline = await options.baseline();
    } catch (err) {
      return verdictIndeterminate(
        'baseline_lookup_unavailable',
        { error: err instanceof Error ? err.message : String(err) },
        lockPeriod,
        300,
        bundle,
      );
    }
  }

  // --- what it cost --------------------------------------------------------
  const holdings = await readHoldings(options, takeoverBlockTime);
  if (holdings) {
    try {
      const outcome = await assessGovernanceExposure({
        before: holdings.before,
        beforeBlockTime: holdings.beforeBlockTime,
        nowHoldings: holdings.now,
        nowFrozen: holdings.frozen,
        nowBlockTime: holdings.nowBlockTime,
        takeoverBlockTime,
        ctx: {
          oracle: priceOracle,
          blockTime: takeoverBlockTime,
          maxSkewSec: options.maxSkewSec ?? DEFAULT_MAX_SKEW_SEC,
          windows: bundle.windows,
          prices: bundle.prices,
        },
      });
      if (outcome.ok) {
        bundle.exposure = outcome.exposure;
      } else {
        // Recorded rather than thrown away: the adjudicator turns an absent
        // valuation into `indeterminate`, and a reviewer needs to know which
        // side could not be priced.
        bundle.programs = {
          ...(bundle.programs ?? {}),
          valuationFailure: { side: outcome.side, ...outcome.failure },
        };
      }
    } catch (err) {
      if (isSourceUnavailable(err)) {
        // A rate-limited price API is not evidence that nothing was seized.
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
  } else {
    bundle.programs = {
      ...(bundle.programs ?? {}),
      holdingsUnavailable: 'No holdings readers supplied; exposure could not be measured.',
    };
  }

  // --- what shape was it ---------------------------------------------------
  bundle.signatures = await collectGovernanceSignatures({
    authority: bundle.authority,
    exposure: bundle.exposure ?? null,
    manifestAuthorities: bundle.baseline ? bundle.baseline.authorities : null,
    agentAddress,
    holderAddress: options.holderAddress,
    txSignature: tx.signature,
    blockTime: takeoverBlockTime,
    reader,
    cohort: options.cohort,
  });

  // --- judge ---------------------------------------------------------------
  const verdict = adjudicateGovernance(bundle);

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
 * Gather the two balance readings the exposure is measured between.
 *
 * Both readers must be present. One without the other would produce a
 * subtraction with an invented operand, which is worse than reporting that
 * the exposure could not be measured.
 */
async function readHoldings(
  options: GovernanceVerifierOptions,
  takeoverBlockTime: number,
): Promise<{
  before: BalanceBaseline;
  beforeBlockTime: number | null;
  now: BalanceReading[];
  frozen: BalanceReading[];
  nowBlockTime: number;
} | null> {
  if (!options.holdingsBefore || !options.holdingsNow) return null;
  const before = await options.holdingsBefore(takeoverBlockTime);
  const now = await options.holdingsNow();
  return {
    before: before.holdings,
    beforeBlockTime: before.blockTime,
    now: now.holdings,
    frozen: now.frozen,
    nowBlockTime: now.blockTime,
  };
}
