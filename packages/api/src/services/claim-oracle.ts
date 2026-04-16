import { TriggerType, LOCK_PERIODS } from '@covantic/shared';
import { HeliusClient } from '../utils/helius.js';
import { PythClient } from '../utils/pyth.js';
import { logger } from '../utils/logger.js';

export interface VerificationResult {
  verified: boolean;
  lossAmount: number;
  confidence: number;
  details: Record<string, unknown>;
  lockPeriod: number;
}

/**
 * Production claim verifier. The four trigger types below previously
 * shipped with placeholder heuristics that approved almost any
 * transaction (any outgoing transfer → "exploit", any fee payer →
 * "governance attack", spot-vs-spot → "oracle manipulation"). Those
 * heuristics have been replaced with explicit UNVERIFIED responses so
 * the keeper correctly rejects until real detection is integrated.
 *
 * The simulated / demo flow lives in claim-keeper.ts `syntheticVerification`
 * and is gated by NODE_ENV + a signed alert bus.
 */
export async function verifyClaim(
  triggerType: TriggerType,
  triggerTxSignature: string,
  agentAddress: string,
  _coverageAmount: number,
  helius: HeliusClient,
  _pyth: PythClient,
): Promise<VerificationResult> {
  logger.info(
    { triggerType, triggerTxSignature, agentAddress },
    'verifyClaim: production verifier stub',
  );

  // Sanity: make sure the triggering tx actually exists on chain before
  // we even consider it. This is cheap and catches the obvious forgery
  // case (an attacker supplying a random signature).
  const tx = await helius.getParsedTransaction(triggerTxSignature).catch(() => null);
  if (!tx) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: { reason: 'trigger_tx_not_found', triggerTxSignature },
      lockPeriod: 0,
    };
  }

  const lockPeriod = lockPeriodFor(triggerType);

  // Explicitly refuse until trigger-specific detection is implemented.
  // Returning verified:false for all triggers is the safe default: it
  // lets monitoring / UX exercise the pipeline without approving fraud.
  return {
    verified: false,
    lossAmount: 0,
    confidence: 0,
    details: {
      reason: 'verifier_not_implemented',
      triggerType,
      note: 'Real trigger detection (pre/post balance diffs, Pyth Benchmarks TWAP, governance authority-change scanning) is pending. The keeper will only pay out demo / simulated claims while this stub is in place.',
    },
    lockPeriod,
  };
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
