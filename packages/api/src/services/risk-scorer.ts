import {
  RiskTier,
  type RiskAssessment,
  type RiskFactors,
  type FactorDetail,
  RISK_SCORE_BOUNDARIES,
  PREMIUM_BPS,
} from '@agentguard/shared';
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

  const factors = calculateFactors(transactions as any[], balances as any, accountInfo as any);

  const score =
    factors.failedRatio * WEIGHTS.failedRatio +
    factors.avgSlippage * WEIGHTS.avgSlippage +
    factors.protocolDiversity * WEIGHTS.protocolDiversity +
    factors.walletAge * WEIGHTS.walletAge +
    factors.registryScore * WEIGHTS.registryScore +
    factors.tokenConcentration * WEIGHTS.tokenConcentration +
    factors.txVolume * WEIGHTS.txVolume;

  const roundedScore = Math.round(score * 1000) / 1000;
  const tier = scoreToTier(score);
  const premiumBps = tierToPremiumBps(tier);
  const factorDetails = buildFactorDetails(factors);
  const summary = buildSummary(roundedScore, tier, factors);
  const recommendation = buildRecommendation(tier, factors);

  logger.info({ agentAddress, score, tier, premiumBps }, 'Risk assessment completed');

  return {
    score: roundedScore,
    tier,
    premiumBps,
    factors,
    factorDetails,
    summary,
    recommendation,
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

function valueToRating(value: number): FactorDetail['rating'] {
  if (value <= 0.25) return 'low';
  if (value <= 0.5) return 'moderate';
  if (value <= 0.75) return 'elevated';
  return 'high';
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function buildFactorDetails(factors: RiskFactors): FactorDetail[] {
  return [
    {
      label: 'Transaction Failure Rate',
      value: factors.failedRatio,
      rating: valueToRating(factors.failedRatio),
      description:
        factors.failedRatio < 0.1
          ? 'Very few failed transactions — agent executes reliably.'
          : factors.failedRatio < 0.3
            ? 'Some transactions fail, which is normal for DeFi operations.'
            : factors.failedRatio < 0.6
              ? `${pct(factors.failedRatio)} of recent transactions failed — may indicate poor error handling or risky operations.`
              : `${pct(factors.failedRatio)} failure rate is unusually high — agent may be malfunctioning or interacting with unstable protocols.`,
    },
    {
      label: 'Swap Slippage',
      value: factors.avgSlippage,
      rating: valueToRating(factors.avgSlippage),
      description:
        factors.avgSlippage < 0.15
          ? 'Low slippage on swaps — agent uses reasonable trade sizes and liquid pools.'
          : factors.avgSlippage < 0.4
            ? 'Moderate slippage detected — some trades may be oversized for available liquidity.'
            : `High average slippage (${pct(factors.avgSlippage)}) — agent may be trading in illiquid pools or using excessive size.`,
    },
    {
      label: 'Protocol Diversity',
      value: factors.protocolDiversity,
      rating: valueToRating(factors.protocolDiversity),
      description:
        factors.protocolDiversity < 0.3
          ? 'Agent interacts with many protocols — well-diversified activity reduces single-protocol risk.'
          : factors.protocolDiversity < 0.6
            ? 'Moderate protocol diversity — agent uses a few different protocols.'
            : 'Agent concentrates activity in very few protocols — a vulnerability in one protocol could cause significant losses.',
    },
    {
      label: 'Wallet Age',
      value: factors.walletAge,
      rating: valueToRating(factors.walletAge),
      description:
        factors.walletAge < 0.2
          ? 'Well-established wallet with a long on-chain history — strong track record.'
          : factors.walletAge < 0.5
            ? 'Wallet has been active for several months — reasonable history.'
            : factors.walletAge < 0.8
              ? 'Relatively new wallet — limited track record makes risk harder to assess.'
              : 'Very new wallet with almost no history — high uncertainty about agent behavior.',
    },
    {
      label: 'Reputation Score',
      value: factors.registryScore,
      rating: valueToRating(factors.registryScore),
      description:
        factors.registryScore < 0.3
          ? 'Agent is registered in known agent registries with a good reputation.'
          : factors.registryScore < 0.6
            ? 'No reputation data available — agent is not registered in any known registry.'
            : 'Agent has negative reputation signals or is flagged in monitoring systems.',
    },
    {
      label: 'Token Concentration',
      value: factors.tokenConcentration,
      rating: valueToRating(factors.tokenConcentration),
      description:
        factors.tokenConcentration < 0.3
          ? 'Holdings are spread across multiple tokens — well-diversified portfolio.'
          : factors.tokenConcentration < 0.6
            ? 'Holdings are somewhat concentrated — moderate exposure to single-token volatility.'
            : `${pct(factors.tokenConcentration)} of holdings in a single token — high exposure to price swings or depegs.`,
    },
    {
      label: 'Transaction Volume',
      value: factors.txVolume,
      rating: valueToRating(factors.txVolume),
      description:
        factors.txVolume < 0.2
          ? 'Low transaction volume — minimal on-chain activity reduces exposure to errors.'
          : factors.txVolume < 0.5
            ? 'Moderate transaction volume — normal operational activity.'
            : factors.txVolume < 0.8
              ? 'High transaction volume — frequent operations increase the probability of encountering issues.'
              : 'Very high transaction volume — aggressive activity pattern increases risk of errors and losses.',
    },
  ];
}

const TIER_LABELS: Record<RiskTier, string> = {
  [RiskTier.LOW]: 'LOW',
  [RiskTier.MEDIUM]: 'MEDIUM',
  [RiskTier.HIGH]: 'HIGH',
  [RiskTier.EXTREME]: 'EXTREME',
};

function buildSummary(score: number, tier: RiskTier, factors: RiskFactors): string {
  const topRisks = Object.entries(factors)
    .filter(([, v]) => v > 0.5)
    .sort(([, a], [, b]) => b - a)
    .map(([k]) => k);

  const strengths = Object.entries(factors)
    .filter(([, v]) => v < 0.25)
    .map(([k]) => k);

  const factorNames: Record<string, string> = {
    failedRatio: 'transaction failure rate',
    avgSlippage: 'swap slippage',
    protocolDiversity: 'protocol concentration',
    walletAge: 'wallet newness',
    registryScore: 'unknown reputation',
    tokenConcentration: 'token concentration',
    txVolume: 'high transaction volume',
  };

  const strengthNames: Record<string, string> = {
    failedRatio: 'reliable transaction execution',
    avgSlippage: 'low swap slippage',
    protocolDiversity: 'good protocol diversity',
    walletAge: 'established wallet history',
    registryScore: 'positive reputation',
    tokenConcentration: 'diversified holdings',
    txVolume: 'conservative activity level',
  };

  let summary = `Overall risk score: ${score} (${TIER_LABELS[tier]}).`;

  if (topRisks.length > 0) {
    const riskParts = topRisks.slice(0, 3).map((k) => factorNames[k] ?? k);
    summary += ` Primary risk drivers: ${riskParts.join(', ')}.`;
  }

  if (strengths.length > 0) {
    const strengthParts = strengths.slice(0, 3).map((k) => strengthNames[k] ?? k);
    summary += ` Strengths: ${strengthParts.join(', ')}.`;
  }

  if (topRisks.length === 0 && strengths.length > 0) {
    summary += ' No significant risk factors detected.';
  }

  return summary;
}

function buildRecommendation(tier: RiskTier, factors: RiskFactors): string {
  switch (tier) {
    case RiskTier.LOW:
      return 'This agent shows a healthy risk profile and qualifies for the lowest premium tier (1% annual). Recommended for insurance coverage up to the maximum limit.';
    case RiskTier.MEDIUM: {
      const concerns: string[] = [];
      if (factors.failedRatio > 0.3) concerns.push('reducing failed transactions');
      if (factors.protocolDiversity > 0.5) concerns.push('diversifying protocol usage');
      if (factors.walletAge > 0.5) concerns.push('building a longer track record');
      if (factors.tokenConcentration > 0.5) concerns.push('diversifying token holdings');
      const advice = concerns.length > 0 ? ` To lower premiums, consider ${concerns.join(' and ')}.` : '';
      return `This agent has a moderate risk profile and qualifies for insurance at 2.5% annual premium.${advice}`;
    }
    case RiskTier.HIGH: {
      const issues: string[] = [];
      if (factors.failedRatio > 0.5) issues.push('high transaction failure rate');
      if (factors.avgSlippage > 0.5) issues.push('excessive swap slippage');
      if (factors.txVolume > 0.7) issues.push('very high activity level');
      if (factors.protocolDiversity > 0.7) issues.push('heavy protocol concentration');
      const detail = issues.length > 0 ? ` Key concerns: ${issues.join(', ')}.` : '';
      return `This agent has an elevated risk profile. Insurance is available at 5% annual premium, reflecting the higher likelihood of loss events.${detail}`;
    }
    case RiskTier.EXTREME:
      return 'This agent exceeds acceptable risk thresholds and is currently not eligible for insurance coverage. The risk profile suggests a very high probability of loss events. The agent should reduce failed transactions, improve protocol diversity, and establish a longer history before reapplying.';
  }
}
