import type { Connection } from '@solana/web3.js';
import { LOCK_PERIODS, TriggerType } from '@covantic/shared';
import { HeliusClient } from '../utils/helius.js';
import { logger } from '../utils/logger.js';
import type { EvidenceBundle, PriceOracle } from './oracle/types.js';
import { verifyAgentError } from './verifiers/agent-error.js';
import { verifyExploit } from './verifiers/exploit.js';
import { verifyGovernanceAttack } from './verifiers/governance-attack.js';
import { verifyOracleManipulation } from './verifiers/oracle-manipulation.js';

/**
 * Terminal state of a verification attempt.
 *
 * The three-way split is the point. A boolean forces "could not check" to
 * masquerade as "did not happen", which is how a rate-limited price API used
 * to permanently close valid claims.
 */
export type VerificationOutcome = 'confirmed' | 'rejected' | 'indeterminate';

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
   *  decision can be replayed and audited. */
  evidence?: EvidenceBundle;
}

export interface VerifyClaimOptions {
  /** USDC mint address (from AppConfig.USDC_MINT). When supplied the
   *  outflow verifiers use authoritative balance deltas instead of
   *  summing tokenTransfers[]. */
  usdcMint?: string;
  /** RPC connection used to cross-check the trigger transaction's block time
   *  against the indexer. Optional: without it the indexer's value is taken
   *  on trust and the disagreement check is skipped. */
  connection?: Connection | null;
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
      return verifyExploit(tx, agentAddress, coverageAmount, options.usdcMint);
    case TriggerType.OracleManipulation:
      return verifyOracleManipulation(tx, agentAddress, coverageAmount, priceOracle, {
        connection: options.connection ?? null,
      });
    case TriggerType.AgentError:
      return verifyAgentError(tx, agentAddress, coverageAmount, options.usdcMint);
    case TriggerType.GovernanceAttack:
      return verifyGovernanceAttack(tx, agentAddress, coverageAmount);
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
