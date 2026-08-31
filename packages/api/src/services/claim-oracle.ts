import { LOCK_PERIODS, TriggerType } from '@covantic/shared';
import { HeliusClient } from '../utils/helius.js';
import { logger } from '../utils/logger.js';
import type { AgentErrorEvidenceBundle } from './agent-error/types.js';
import type { ExploitEvidenceBundle } from './exploit/types.js';
import type { GovernanceEvidenceBundle } from './governance/types.js';
import type { EvidenceBundle, PriceOracle } from './oracle/types.js';
import type { CohortLookup } from './exploit/signatures.js';
import {
  verifyAgentError,
  type AgentErrorVerifierOptions,
} from './verifiers/agent-error.js';
import { verifyExploit } from './verifiers/exploit.js';
import {
  verifyGovernanceAttack,
  type GovernanceVerifierOptions,
} from './verifiers/governance-attack.js';
import { verifyOracleManipulation } from './verifiers/oracle-manipulation.js';
import type { SolanaReader } from '../utils/solana-reader.js';

/**
 * Terminal state of a verification attempt.
 *
 * The three-way split is the point. A boolean forces "could not check" to
 * masquerade as "did not happen", which is how a rate-limited price API used
 * to permanently close valid claims.
 */
export type VerificationOutcome = 'confirmed' | 'rejected' | 'indeterminate';

/** Every evidence shape the keeper may be handed. */
export type AnyEvidenceBundle =
  | EvidenceBundle
  | ExploitEvidenceBundle
  | GovernanceEvidenceBundle
  | AgentErrorEvidenceBundle;

export interface VerificationResult {
  outcome: VerificationOutcome;
  /** Convenience mirror of `outcome === 'confirmed'`. Always set by the
   *  builders in verifiers/common.ts so the two cannot drift. */
  verified: boolean;
  lossAmount: number;
  confidence: number;
  details: Record<string, unknown>;
  lockPeriod: number;
  /** Set only when `outcome === 'indeterminate'` — how long to wait before
   *  the next attempt. */
  retryAfterSec?: number;
  /** Everything the verdict was derived from. Persisted by the keeper so the
   *  decision can be replayed and audited. One shape per trigger: both carry
   *  `triggerType`, which is what lets a replay pick the right adjudicator
   *  without consulting the claim row. */
  evidence?: AnyEvidenceBundle;
}

export interface VerifyClaimOptions {
  /** USDC mint address (from AppConfig.USDC_MINT). When supplied the
   *  outflow verifiers use authoritative balance deltas instead of
   *  summing tokenTransfers[]. */
  usdcMint?: string;
  /** Multi-endpoint chain reader, used to cross-check the trigger
   *  transaction's block time against the indexer and — for exploits — to
   *  read the chain's own record of who signed for what. Without it an
   *  exploit claim cannot be resolved at all and returns `indeterminate`. */
  reader?: SolanaReader | null;
  /**
   * Seconds the payout stays locked after the claim is submitted.
   *
   * Mirrors the program's `LOCK_EXPLOIT`, which a devnet build can shorten.
   * Never *below* the deployed program's value: the chain refuses a payout
   * inside its own lock and the keeper records a revert as `failed`.
   */
  exploitLockSeconds?: number;
  /** Policy holder wallet. Value landing in an account the holder controls is
   *  the holder moving their own money, not a loss the vault owes. */
  holderAddress?: string;
  /** Finds other insured agents hit by the same counterparty in the window. */
  cohort?: CohortLookup;
  /**
   * Lookups only the governance path needs: the holder's declared authority
   * set and the two balance readings its exposure is measured between.
   *
   * Injected rather than imported so `claim-oracle` stays free of database
   * and Anchor-program coupling. Absent, a governance claim resolves to
   * review — which is the correct behaviour before
   * `declare_governance_baseline` is deployed, and never a rejection.
   */
  governance?: Omit<GovernanceVerifierOptions, 'reader' | 'holderAddress' | 'cohort'>;
  /**
   * Lookups only the agent-error path needs: the holder's declared operating
   * envelope, and the agent's own outflow history.
   *
   * Injected for the same reason the governance ones are — so `claim-oracle`
   * stays free of database and Anchor-program coupling, and so a corpus test
   * can drive the verifier with neither. Absent, an agent-error claim resolves
   * to review, which is the correct behaviour before `declare_agent_mandate`
   * is deployed and never a rejection.
   */
  agentError?: Omit<
    AgentErrorVerifierOptions,
    'reader' | 'holderAddress' | 'coveredMint'
  >;
}

/**
 * Production claim verifier. Dispatches on TriggerType to a per-trigger
 * verifier that inspects the actual on-chain transaction and returns a
 * real loss amount + confidence score.
 *
 * The simulated / demo flow lives in claim-keeper.ts `syntheticVerification`
 * and is gated by NODE_ENV + a signed alert bus — it never flows through
 * this path for real (87-88 char Base58) signatures.
 */
export async function verifyClaim(
  triggerType: TriggerType,
  triggerTxSignature: string,
  agentAddress: string,
  coverageAmount: number,
  helius: HeliusClient,
  priceOracle: PriceOracle,
  options: VerifyClaimOptions = {},
): Promise<VerificationResult> {
  logger.info({ triggerType, triggerTxSignature, agentAddress }, 'verifyClaim: dispatching');

  const tx = await helius.getParsedTransaction(triggerTxSignature).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : err, triggerTxSignature },
      'verifyClaim: getParsedTransaction failed',
    );
    return null;
  });

  if (!tx) {
    // Indexers lag. A signature that is not resolvable yet is not evidence
    // that nothing happened, so this retries instead of closing the claim.
    return {
      outcome: 'indeterminate',
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'trigger_tx_not_found',
        triggerTxSignature,
        note: 'Transaction not resolvable yet — indexer lag or wrong cluster.',
      },
      lockPeriod: lockPeriodFor(triggerType),
      retryAfterSec: 30,
    };
  }

  switch (triggerType) {
    case TriggerType.Exploit:
      return verifyExploit(tx, agentAddress, coverageAmount, priceOracle, {
        reader: options.reader ?? null,
        exploitLockSeconds: options.exploitLockSeconds,
        holderAddress: options.holderAddress,
        cohort: options.cohort,
      });
    case TriggerType.OracleManipulation:
      return verifyOracleManipulation(tx, agentAddress, coverageAmount, priceOracle, {
        reader: options.reader ?? null,
      });
    case TriggerType.AgentError:
      return verifyAgentError(tx, agentAddress, coverageAmount, priceOracle, {
        ...(options.agentError ?? {}),
        reader: options.reader ?? null,
        holderAddress: options.holderAddress,
        coveredMint: options.usdcMint,
      });
    case TriggerType.GovernanceAttack:
      return verifyGovernanceAttack(tx, agentAddress, coverageAmount, priceOracle, {
        ...(options.governance ?? {}),
        reader: options.reader ?? null,
        holderAddress: options.holderAddress,
        cohort: options.cohort,
      });
    default:
      return {
        outcome: 'rejected',
        verified: false,
        lossAmount: 0,
        confidence: 0,
        details: { reason: 'unknown_trigger_type', triggerType },
        lockPeriod: 0,
      };
  }
}

function lockPeriodFor(triggerType: TriggerType): number {
  switch (triggerType) {
    case TriggerType.Exploit:
      return LOCK_PERIODS.EXPLOIT;
    case TriggerType.OracleManipulation:
      return LOCK_PERIODS.ORACLE_MANIPULATION;
    case TriggerType.AgentError:
      return LOCK_PERIODS.AGENT_ERROR;
    case TriggerType.GovernanceAttack:
      return LOCK_PERIODS.GOVERNANCE_ATTACK;
    default:
      return 0;
  }
}
