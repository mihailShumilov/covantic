import { RiskTier, type RiskAssessment, type RiskFactors } from '@agentguard/shared';
import { RISK_SCORE_BOUNDARIES, PREMIUM_BPS } from '@agentguard/shared';
import { HeliusClient } from '../utils/helius.js';
import { logger } from '../utils/logger.js';

/** Weights for each risk factor */
const WEIGHTS = {
  failedRatio: 0.2,
  avgSlippage: 0.15,
  protocolDiversity: 0.15,
  walletAge: 0.1,
  registryScore: 0.1,
  tokenConcentration: 0.1,
  txVolume: 0.2,
} as const;

/**
 * Full risk scoring pipeline:
 * 1. Fetch agent transactions via Helius Enhanced TX API
 * 2. Fetch token balances
 * 3. Calculate each factor
 * 4. Weight and sum -> final score
 * 5. Determine tier and premium
 */
export async function assessRisk(
  agentAddress: string,
  helius: HeliusClient,
): Promise<RiskAssessment> {
  const [transactions, balances, accountInfo] = await Promise.all([
    helius.getEnhancedTransactions(agentAddress, { limit: 100 }),
    helius.getTokenBalances(agentAddress),
    helius.getAccountInfo(agentAddress),
  ]);

  const factors = calculateFactors(transactions, balances, accountInfo);

  const score =
    factors.failedRatio * WEIGHTS.failedRatio +
    factors.avgSlippage * WEIGHTS.avgSlippage +
    factors.protocolDiversity * WEIGHTS.protocolDiversity +
    factors.walletAge * WEIGHTS.walletAge +
    factors.registryScore * WEIGHTS.registryScore +
    factors.tokenConcentration * WEIGHTS.tokenConcentration +
    factors.txVolume * WEIGHTS.txVolume;

  const tier = scoreToTier(score);
  const premiumBps = tierToPremiumBps(tier);

  logger.info({ agentAddress, score, tier, premiumBps }, 'Risk assessment completed');

  return {
    score: Math.round(score * 1000) / 1000,
    tier,
    premiumBps,
    factors,
    assessedAt: new Date(),
  };
}

/** Calculate all 7 risk factors from on-chain data. All normalized 0-1, higher = riskier. */
function calculateFactors(transactions: any[], balances: any, accountInfo: any): RiskFactors {
  const txs = Array.isArray(transactions) ? transactions : [];

  // 1. Failed transaction ratio
  const totalTx = txs.length;
  const failedTx = txs.filter((tx: any) => tx.transactionError != null).length;
  const failedRatio = totalTx > 0 ? failedTx / totalTx : 0.5;

  // 2. Average slippage (estimated from swap transactions)
  const swapTxs = txs.filter((tx: any) => tx.type === 'SWAP');
  let avgSlippage = 0.5; // Default mid-risk
  if (swapTxs.length > 0) {
    // Estimate slippage from token amount differences
    const slippages = swapTxs.map((tx: any) => {
      const tokenTransfers = tx.tokenTransfers ?? [];
      if (tokenTransfers.length >= 2) {
        // Rough heuristic: large token amount differences indicate high slippage
        return Math.min(Math.random() * 0.1, 1); // Simplified for dev
      }
      return 0.05;
    });
    avgSlippage = slippages.reduce((a: number, b: number) => a + b, 0) / slippages.length;
    avgSlippage = Math.min(avgSlippage * 10, 1); // Normalize to 0-1
  }

  // 3. Protocol diversity (fewer protocols = higher risk)
  const programs = new Set<string>();
  txs.forEach((tx: any) => {
    (tx.instructions ?? []).forEach((ix: any) => {
      if (ix.programId) programs.add(ix.programId);
    });
  });
  // 1 protocol = 1.0 risk, 10+ = 0.0 risk
  const protocolDiversity = Math.max(0, 1 - (programs.size - 1) / 9);

  // 4. Wallet age (newer = riskier)
  let walletAge = 0.5;
  if (accountInfo?.createdAt) {
    const ageDays = (Date.now() - new Date(accountInfo.createdAt).getTime()) / (1000 * 86400);
    // < 7 days = 1.0, > 365 days = 0.0
    walletAge = Math.max(0, 1 - ageDays / 365);
  } else if (txs.length > 0) {
    // Estimate from earliest transaction
    const earliest = txs[txs.length - 1];
    if (earliest?.timestamp) {
      const ageDays = (Date.now() / 1000 - earliest.timestamp) / 86400;
      walletAge = Math.max(0, 1 - ageDays / 365);
    }
  }

  // 5. Registry score (external reputation — default 0.5 unknown)
  // In production, check against known agent registries
  const registryScore = 0.5;

  // 6. Token concentration (high concentration in one token = higher risk)
  let tokenConcentration = 0.5;
  const tokens = balances?.tokens ?? [];
  if (tokens.length > 0) {
    const amounts = tokens.map((t: any) => t.amount ?? 0);
    const totalValue = amounts.reduce((a: number, b: number) => a + b, 0);
    if (totalValue > 0) {
      const maxToken = Math.max(...amounts);
      tokenConcentration = maxToken / totalValue; // HHI-like single-token concentration
    }
  }

  // 7. Transaction volume risk (very high volume = higher risk of errors)
  let txVolume = 0.5;
  if (totalTx > 0) {
    // > 50 tx in last 100 window = high activity. Normalize: 100 tx = 1.0
    txVolume = Math.min(totalTx / 100, 1);
  }

  return {
    failedRatio: clamp(failedRatio),
    avgSlippage: clamp(avgSlippage),
    protocolDiversity: clamp(protocolDiversity),
    walletAge: clamp(walletAge),
    registryScore: clamp(registryScore),
    tokenConcentration: clamp(tokenConcentration),
    txVolume: clamp(txVolume),
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function scoreToTier(score: number): RiskTier {
  if (score <= RISK_SCORE_BOUNDARIES.LOW_MAX) return RiskTier.LOW;
  if (score <= RISK_SCORE_BOUNDARIES.MEDIUM_MAX) return RiskTier.MEDIUM;
  if (score <= RISK_SCORE_BOUNDARIES.HIGH_MAX) return RiskTier.HIGH;
  return RiskTier.EXTREME;
}

function tierToPremiumBps(tier: RiskTier): number {
  switch (tier) {
    case RiskTier.LOW:
      return PREMIUM_BPS.LOW;
    case RiskTier.MEDIUM:
      return PREMIUM_BPS.MEDIUM;
    case RiskTier.HIGH:
      return PREMIUM_BPS.HIGH;
    case RiskTier.EXTREME:
      return -1;
  }
}
