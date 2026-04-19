import { LOCK_PERIODS, TriggerType } from '@covantic/shared';
import { HeliusClient } from '../utils/helius.js';
import { PythClient } from '../utils/pyth.js';
import { logger } from '../utils/logger.js';
import { verifyAgentError } from './verifiers/agent-error.js';
import { verifyExploit } from './verifiers/exploit.js';
import { verifyGovernanceAttack } from './verifiers/governance-attack.js';
import { verifyOracleManipulation } from './verifiers/oracle-manipulation.js';

export interface VerificationResult {
  verified: boolean;
  lossAmount: number;
  confidence: number;
  details: Record<string, unknown>;
  lockPeriod: number;
}

export interface VerifyClaimOptions {
  /** USDC mint address (from AppConfig.USDC_MINT). When supplied the
   *  outflow verifiers use authoritative balance deltas instead of
   *  summing tokenTransfers[]. */
  usdcMint?: string;
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
  pyth: PythClient,
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
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: { reason: 'trigger_tx_not_found', triggerTxSignature },
      lockPeriod: lockPeriodFor(triggerType),
    };
  }

  switch (triggerType) {
    case TriggerType.Exploit:
      return verifyExploit(tx, agentAddress, coverageAmount, options.usdcMint);
    case TriggerType.OracleManipulation:
      return verifyOracleManipulation(tx, agentAddress, coverageAmount, pyth);
    case TriggerType.AgentError:
      return verifyAgentError(tx, agentAddress, coverageAmount, options.usdcMint);
    case TriggerType.GovernanceAttack:
      return verifyGovernanceAttack(tx, agentAddress, coverageAmount);
    default:
      return {
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
