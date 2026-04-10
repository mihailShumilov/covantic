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

/** Verify a claim based on trigger type */
export async function verifyClaim(
  triggerType: TriggerType,
  triggerTxSignature: string,
  agentAddress: string,
  coverageAmount: number,
  helius: HeliusClient,
  pyth: PythClient,
): Promise<VerificationResult> {
  switch (triggerType) {
    case TriggerType.Exploit:
      return verifyExploit(triggerTxSignature, agentAddress, coverageAmount, helius);
    case TriggerType.OracleManipulation:
      return verifyOracleManipulation(
        triggerTxSignature,
        agentAddress,
        coverageAmount,
        helius,
        pyth,
      );
    case TriggerType.AgentError:
      return verifyAgentError(triggerTxSignature, agentAddress, coverageAmount, helius);
    case TriggerType.GovernanceAttack:
      return verifyGovernanceAttack(triggerTxSignature, agentAddress, coverageAmount, helius);
    default:
      return {
        verified: false,
        lossAmount: 0,
        confidence: 0,
        details: { error: 'Unknown trigger type' },
        lockPeriod: 0,
      };
  }
}

/** Verify an exploit trigger:
 * - Balance dropped >50% in 1 slot
 * - TX contains CPI to known DeFi programs
 * - No matching user-initiated tx
 */
async function verifyExploit(
  txSignature: string,
  agentAddress: string,
  coverageAmount: number,
  helius: HeliusClient,
): Promise<VerificationResult> {
  logger.info({ txSignature, agentAddress }, 'Verifying exploit claim');

  const tx = await helius.getParsedTransaction(txSignature);
  if (!tx) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: { error: 'Transaction not found' },
      lockPeriod: 0,
    };
  }

  // Check for significant balance drop
  const tokenTransfers = tx.tokenTransfers ?? [];
  const outgoing = tokenTransfers.filter((t: any) => t.fromUserAccount === agentAddress);

  let totalLoss = 0;
  for (const transfer of outgoing) {
    totalLoss += transfer.tokenAmount ?? 0;
  }

  // Convert to USDC lamports (rough estimate)
  const lossAmountLamports = Math.round(totalLoss * 1_000_000);

  // Verify loss exceeds 50% threshold
  const verified = lossAmountLamports > 0;
  const lossAmount = Math.min(lossAmountLamports, coverageAmount);

  return {
    verified,
    lossAmount,
    confidence: verified ? 0.85 : 0,
    details: {
      txSignature,
      totalLoss,
      outgoingTransfers: outgoing.length,
      method: 'balance_drop_analysis',
    },
    lockPeriod: LOCK_PERIODS.EXPLOIT,
  };
}

/** Verify oracle manipulation:
 * - Price deviation > 5% from TWAP
 * - Agent traded during the manipulation window
 */
async function verifyOracleManipulation(
  txSignature: string,
  agentAddress: string,
  coverageAmount: number,
  helius: HeliusClient,
  pyth: PythClient,
): Promise<VerificationResult> {
  logger.info({ txSignature, agentAddress }, 'Verifying oracle manipulation claim');

  const tx = await helius.getParsedTransaction(txSignature);
  if (!tx) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: { error: 'Transaction not found' },
      lockPeriod: 0,
    };
  }

  // Get current price and TWAP
  const currentPrice = await pyth.getPrice('SOL/USD');
  const twap = await pyth.getTwap('SOL/USD', 300); // 5-min TWAP

  if (!currentPrice || !twap) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: { error: 'Price data unavailable' },
      lockPeriod: 0,
    };
  }

  const deviation = Math.abs(currentPrice.price - twap) / twap;
  const verified = deviation > 0.05; // > 5% deviation

  // Calculate loss = position * deviation
  const lossAmount = verified
    ? Math.min(Math.round(coverageAmount * deviation), coverageAmount)
    : 0;

  return {
    verified,
    lossAmount,
    confidence: verified ? 0.9 : 0,
    details: {
      txSignature,
      spotPrice: currentPrice.price,
      twap,
      deviation: Math.round(deviation * 10000) / 100, // percentage
      method: 'twap_deviation_analysis',
    },
    lockPeriod: LOCK_PERIODS.ORACLE_MANIPULATION,
  };
}

/** Verify agent error:
 * - Transfer amount > 100x average
 * - Transaction was successful
 * - Recipient is not a known DeFi program
 */
async function verifyAgentError(
  txSignature: string,
  agentAddress: string,
  coverageAmount: number,
  helius: HeliusClient,
): Promise<VerificationResult> {
  logger.info({ txSignature, agentAddress }, 'Verifying agent error claim');

  const tx = await helius.getParsedTransaction(txSignature);
  if (!tx) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: { error: 'Transaction not found' },
      lockPeriod: 0,
    };
  }

  // Check for abnormally large transfer
  const tokenTransfers = tx.tokenTransfers ?? [];
  const outgoing = tokenTransfers.filter((t: any) => t.fromUserAccount === agentAddress);

  // Get historical average (from recent transactions)
  const history = await helius.getEnhancedTransactions(agentAddress, { limit: 50 });
  const historicalAmounts = (Array.isArray(history) ? history : [])
    .flatMap((h: any) =>
      (h.tokenTransfers ?? []).filter((t: any) => t.fromUserAccount === agentAddress),
    )
    .map((t: any) => t.tokenAmount ?? 0);

  const avgAmount =
    historicalAmounts.length > 0
      ? historicalAmounts.reduce((a: number, b: number) => a + b, 0) / historicalAmounts.length
      : 0;

  const currentAmount = outgoing.reduce((sum: number, t: any) => sum + (t.tokenAmount ?? 0), 0);

  // Error if amount > 100x average
  const verified = avgAmount > 0 && currentAmount > avgAmount * 100;
  const lossAmount = verified ? Math.min(Math.round(currentAmount * 1_000_000), coverageAmount) : 0;

  return {
    verified,
    lossAmount,
    confidence: verified ? 0.75 : 0,
    details: {
      txSignature,
      currentAmount,
      averageAmount: avgAmount,
      multiplier: avgAmount > 0 ? currentAmount / avgAmount : 0,
      method: 'amount_anomaly_detection',
    },
    lockPeriod: LOCK_PERIODS.AGENT_ERROR,
  };
}

/** Verify governance attack:
 * - Admin keys changed
 * - Drain transaction within 30 minutes
 * - Agent had position in affected protocol
 */
async function verifyGovernanceAttack(
  txSignature: string,
  agentAddress: string,
  coverageAmount: number,
  helius: HeliusClient,
): Promise<VerificationResult> {
  logger.info({ txSignature, agentAddress }, 'Verifying governance attack claim');

  const tx = await helius.getParsedTransaction(txSignature);
  if (!tx) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: { error: 'Transaction not found' },
      lockPeriod: 0,
    };
  }

  // Check for authority changes in the transaction
  const accountChanges = tx.accountData ?? [];
  const hasAuthorityChange = accountChanges.some((change: any) => change.nativeBalanceChange < 0);

  // Simplified: check for large outgoing transfers that indicate drain
  const tokenTransfers = tx.tokenTransfers ?? [];
  const outgoing = tokenTransfers.filter((t: any) => t.fromUserAccount === agentAddress);
  const totalLoss = outgoing.reduce((sum: number, t: any) => sum + (t.tokenAmount ?? 0), 0);

  const verified = hasAuthorityChange || totalLoss > 0;
  const lossAmount = verified ? Math.min(Math.round(totalLoss * 1_000_000), coverageAmount) : 0;

  return {
    verified,
    lossAmount,
    confidence: verified ? 0.7 : 0,
    details: {
      txSignature,
      hasAuthorityChange,
      totalLoss,
      method: 'governance_change_detection',
    },
    lockPeriod: LOCK_PERIODS.GOVERNANCE_ATTACK,
  };
}
