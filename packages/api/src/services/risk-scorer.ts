import {
  RiskTier,
  scoreToTier,
  tierToPremiumBps,
  TIER_LABELS,
} from '@agentguard/shared';
import type {
  RiskAssessment,
  RiskFactors,
  RiskCategory,
  FactorDetail,
  FactorWeightInfo,
  CategoryRisk,
  DataAvailability,
} from '@agentguard/shared';
import {
  KNOWN_DEX_PROGRAMS,
  KNOWN_BRIDGE_PROGRAMS,
  FLASH_LOAN_PROGRAMS,
} from '../utils/helius.js';
import type { HeliusClient } from '../utils/helius.js';
import { SolanaRpcAnalyzer } from '../utils/solana-rpc-analyzer.js';
import type {
  AnalyzedTransaction,
  AnalyzedTokenBalance,
  AnalyzedAccountInfo,
} from '../utils/solana-rpc-analyzer.js';
import type { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

// Re-export transaction types for compatibility
type EnhancedTransaction = AnalyzedTransaction;
type TokenBalance = AnalyzedTokenBalance;
type AccountInfo = AnalyzedAccountInfo;

// ═══════════════════════════════════════════════════════════════════════════════
// FACTOR CONFIGURATION — base weights per factor, grouped by category
// ═══════════════════════════════════════════════════════════════════════════════

interface FactorConfig {
  key: keyof RiskFactors;
  category: RiskCategory;
  baseWeight: number;
  /** Minimum data points needed for full confidence */
  minDataPoints: number;
}

const FACTOR_CONFIGS: FactorConfig[] = [
  // Transaction Behavior (total base weight: 0.30)
  { key: 'failedTxRatio',       category: 'transaction_behavior', baseWeight: 0.10, minDataPoints: 10 },
  { key: 'avgSlippage',         category: 'transaction_behavior', baseWeight: 0.08, minDataPoints: 3 },
  { key: 'txVelocityAnomaly',   category: 'transaction_behavior', baseWeight: 0.07, minDataPoints: 20 },
  { key: 'sandwichVictim',      category: 'transaction_behavior', baseWeight: 0.05, minDataPoints: 5 },

  // Protocol & DeFi Risk (total base weight: 0.22)
  { key: 'protocolConcentration',  category: 'protocol_defi', baseWeight: 0.08, minDataPoints: 5 },
  { key: 'riskyProtocolExposure',  category: 'protocol_defi', baseWeight: 0.08, minDataPoints: 5 },
  { key: 'defiComplexity',         category: 'protocol_defi', baseWeight: 0.06, minDataPoints: 3 },

  // Wallet & Identity (total base weight: 0.18)
  { key: 'walletAge',                    category: 'wallet_identity', baseWeight: 0.07, minDataPoints: 1 },
  { key: 'solBalanceHealth',              category: 'wallet_identity', baseWeight: 0.05, minDataPoints: 1 },
  { key: 'fundingSourceConcentration',    category: 'wallet_identity', baseWeight: 0.06, minDataPoints: 3 },

  // Portfolio Risk (total base weight: 0.18)
  { key: 'tokenConcentration',  category: 'portfolio', baseWeight: 0.07, minDataPoints: 2 },
  { key: 'portfolioValueRisk',  category: 'portfolio', baseWeight: 0.05, minDataPoints: 1 },
  { key: 'stablecoinRatio',     category: 'portfolio', baseWeight: 0.06, minDataPoints: 1 },

  // Behavioral Patterns (total base weight: 0.12)
  { key: 'activityRegularity', category: 'behavioral_patterns', baseWeight: 0.06, minDataPoints: 15 },
  { key: 'recentRiskTrend',    category: 'behavioral_patterns', baseWeight: 0.06, minDataPoints: 20 },
];

const CATEGORY_LABELS: Record<RiskCategory, string> = {
  transaction_behavior: 'Transaction Behavior',
  protocol_defi: 'Protocol & DeFi Risk',
  wallet_identity: 'Wallet & Identity',
  portfolio: 'Portfolio Risk',
  behavioral_patterns: 'Behavioral Patterns',
};

// Known stablecoin mints on Solana
const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',  // USDS
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL (liquid staking)
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
]);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Full risk scoring pipeline with 15-factor dynamic weighted analysis:
 *
 * 1. Fetch on-chain data via Solana RPC (primary) or Helius (fallback)
 * 2. Analyze data availability to determine confidence per factor
 * 3. Calculate all 15 risk factors across 5 categories
 * 4. Apply dynamic confidence-weighted scoring
 * 5. Aggregate category-level and overall risk scores
 * 6. Generate detailed human-readable assessment
 */
export async function assessRisk(
  agentAddress: string,
  solanaConnection: Connection,
  helius?: HeliusClient,
): Promise<RiskAssessment> {
  const rpcAnalyzer = new SolanaRpcAnalyzer(solanaConnection);

  // Step 1: Fetch on-chain data — try Solana RPC first (works on all clusters)
  let transactions: AnalyzedTransaction[];
  let balances: { tokens: AnalyzedTokenBalance[]; nativeBalance: number };
  let accountInfo: AnalyzedAccountInfo | null;

  try {
    [transactions, balances, accountInfo] = await Promise.all([
      rpcAnalyzer.getAnalyzedTransactions(agentAddress, 100),
      rpcAnalyzer.getTokenBalances(agentAddress),
      rpcAnalyzer.getAccountInfo(agentAddress),
    ]);

    logger.info(
      { agentAddress, source: 'solana-rpc', txCount: transactions.length, tokenCount: balances.tokens.length },
      'Fetched on-chain data via Solana RPC',
    );
  } catch (rpcError) {
    logger.warn({ agentAddress, error: rpcError }, 'Solana RPC failed, trying Helius fallback');

    if (helius) {
      const [heliusTxs, heliusBal, heliusInfo] = await Promise.all([
        helius.getEnhancedTransactions(agentAddress, { limit: 100 }),
        helius.getTokenBalances(agentAddress),
        helius.getAccountInfo(agentAddress),
      ]);
      transactions = heliusTxs as AnalyzedTransaction[];
      balances = heliusBal as { tokens: AnalyzedTokenBalance[]; nativeBalance: number };
      accountInfo = heliusInfo as AnalyzedAccountInfo | null;
    } else {
      transactions = [];
      balances = { tokens: [], nativeBalance: 0 };
      accountInfo = null;
    }
  }

  const txs = Array.isArray(transactions) ? transactions : [];
  const tokens = balances?.tokens ?? [];
  const nativeBalance = balances?.nativeBalance ?? 0;

  // Step 2: Compute data availability for confidence weighting
  const swapTxs = txs.filter((tx) => tx.type === 'SWAP');
  const incomingTxs = txs.filter((tx) =>
    (tx.nativeTransfers ?? []).some((t) => t.toUserAccount === agentAddress) ||
    (tx.tokenTransfers ?? []).some((t) => t.toUserAccount === agentAddress),
  );

  const walletAgeDays = computeWalletAgeDays(accountInfo, txs);

  const dataAvailability: DataAvailability = {
    transactionCount: txs.length,
    swapCount: swapTxs.length,
    tokenCount: tokens.length,
    hasAccountInfo: accountInfo != null,
    walletAgeDays,
    hasSolBalance: nativeBalance > 0,
    incomingTxCount: incomingTxs.length,
  };

  // Step 3: Calculate all 15 risk factors
  const factors = calculateAllFactors(agentAddress, txs, tokens, nativeBalance, accountInfo, dataAvailability);

  // Step 4: Calculate confidence per factor and effective weights
  const weightInfo = calculateDynamicWeights(dataAvailability);

  // Step 5: Compute weighted score
  const totalEffectiveWeight = weightInfo.reduce((sum, w) => sum + w.effectiveWeight, 0);
  let rawScore = 0;
  for (const w of weightInfo) {
    rawScore += factors[w.factor] * w.effectiveWeight;
  }
  const score = totalEffectiveWeight > 0
    ? Math.round((rawScore / totalEffectiveWeight) * 1000) / 1000
    : 0.5; // Default mid-risk when no data

  const overallConfidence = weightInfo.reduce((sum, w) => sum + w.confidence, 0) / weightInfo.length;

  // Step 6: Build category-level risks
  const categoryRisks = buildCategoryRisks(factors, weightInfo);

  // Step 7: Determine tier and premium
  const tier = scoreToTier(score);
  const premiumBps = tierToPremiumBps(tier);

  // Step 8: Generate human-readable output
  const factorDetails = buildFactorDetails(factors, weightInfo, dataAvailability);
  const summary = buildSummary(score, tier, factors, categoryRisks, overallConfidence);
  const recommendation = buildRecommendation(tier, factors, categoryRisks);

  logger.info(
    { agentAddress, score, tier, premiumBps, confidence: overallConfidence, txCount: txs.length },
    'Risk assessment completed',
  );

  return {
    score,
    tier,
    premiumBps,
    factors,
    factorDetails,
    categoryRisks,
    weightInfo,
    dataAvailability,
    overallConfidence: Math.round(overallConfidence * 100) / 100,
    summary,
    recommendation,
    assessedAt: new Date(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTOR CALCULATIONS — each returns 0.0 to 1.0 (higher = riskier)
// ═══════════════════════════════════════════════════════════════════════════════

function calculateAllFactors(
  agentAddress: string,
  txs: EnhancedTransaction[],
  tokens: TokenBalance[],
  nativeBalanceLamports: number,
  accountInfo: AccountInfo | null,
  data: DataAvailability,
): RiskFactors {
  return {
    // Transaction Behavior
    failedTxRatio: calcFailedTxRatio(txs),
    avgSlippage: calcAvgSlippage(txs),
    txVelocityAnomaly: calcTxVelocityAnomaly(txs),
    sandwichVictim: calcSandwichVictim(agentAddress, txs),

    // Protocol & DeFi Risk
    protocolConcentration: calcProtocolConcentration(txs),
    riskyProtocolExposure: calcRiskyProtocolExposure(txs),
    defiComplexity: calcDefiComplexity(txs),

    // Wallet & Identity
    walletAge: calcWalletAge(data.walletAgeDays),
    solBalanceHealth: calcSolBalanceHealth(nativeBalanceLamports, txs),
    fundingSourceConcentration: calcFundingSourceConcentration(agentAddress, txs),

    // Portfolio
    tokenConcentration: calcTokenConcentration(tokens, nativeBalanceLamports),
    portfolioValueRisk: calcPortfolioValueRisk(tokens, nativeBalanceLamports),
    stablecoinRatio: calcStablecoinRatio(tokens),

    // Behavioral Patterns
    activityRegularity: calcActivityRegularity(txs),
    recentRiskTrend: calcRecentRiskTrend(txs),
  };
}

// ── Transaction Behavior ────────────────────────────────────────────────────

/** Time-weighted failed transaction ratio — recent failures count more */
function calcFailedTxRatio(txs: EnhancedTransaction[]): number {
  if (txs.length === 0) return 0.5;

  const now = Date.now() / 1000;
  let weightedFailed = 0;
  let totalWeight = 0;

  for (const tx of txs) {
    // Exponential decay: recent txs weigh more (half-life ~7 days)
    const ageSeconds = now - tx.timestamp;
    const ageDays = ageSeconds / 86400;
    const weight = Math.exp(-0.1 * ageDays);

    totalWeight += weight;
    if (tx.transactionError != null) {
      weightedFailed += weight;
    }
  }

  return totalWeight > 0 ? clamp(weightedFailed / totalWeight) : 0.5;
}

/** Average slippage on swap transactions with outlier detection */
function calcAvgSlippage(txs: EnhancedTransaction[]): number {
  const swaps = txs.filter((tx) => tx.type === 'SWAP');
  if (swaps.length === 0) return 0.5;

  const slippages: number[] = [];

  for (const tx of swaps) {
    const transfers = tx.tokenTransfers ?? [];
    if (transfers.length < 2) {
      slippages.push(0.05);
      continue;
    }

    // Look at token balance changes for more accurate slippage
    const inAmount = Math.abs(transfers[0]?.tokenAmount ?? 0);
    const outAmount = Math.abs(transfers[1]?.tokenAmount ?? 0);

    if (inAmount > 0 && outAmount > 0) {
      const ratio = Math.min(inAmount, outAmount) / Math.max(inAmount, outAmount);
      slippages.push(clamp(1 - ratio));
    } else {
      slippages.push(0.05);
    }
  }

  // Use trimmed mean (remove top/bottom 10%) to reduce outlier impact
  slippages.sort((a, b) => a - b);
  const trimStart = Math.floor(slippages.length * 0.1);
  const trimEnd = Math.max(trimStart + 1, Math.ceil(slippages.length * 0.9));
  const trimmed = slippages.slice(trimStart, trimEnd);

  const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

  // Normalize: 0.01 (1% slippage) is moderate, 0.05+ (5%) is high
  return clamp(mean * 10);
}

/** Detect sudden spikes in transaction velocity vs baseline */
function calcTxVelocityAnomaly(txs: EnhancedTransaction[]): number {
  if (txs.length < 10) return 0.3; // Not enough data — slightly conservative

  // Split transactions into time windows (6-hour buckets)
  const BUCKET_SIZE = 6 * 3600;
  const buckets = new Map<number, number>();

  for (const tx of txs) {
    const bucket = Math.floor(tx.timestamp / BUCKET_SIZE);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  const counts = [...buckets.values()];
  if (counts.length < 3) return 0.2;

  // Calculate mean and standard deviation
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
  const stdDev = Math.sqrt(variance);

  if (mean === 0) return 0.2;

  // Check if the most recent bucket has a spike (> 2 std devs above mean)
  const sortedBuckets = [...buckets.entries()].sort((a, b) => b[0] - a[0]);
  const recentCount = sortedBuckets[0]?.[1] ?? 0;

  const zScore = stdDev > 0 ? (recentCount - mean) / stdDev : 0;

  // Also check coefficient of variation (high variance = erratic behavior)
  const cv = mean > 0 ? stdDev / mean : 0;

  // Combine z-score of recent activity with overall volatility
  const spikeScore = clamp(zScore / 4); // z=4 maps to 1.0
  const volatilityScore = clamp(cv / 2); // cv=2 maps to 1.0

  return clamp(spikeScore * 0.6 + volatilityScore * 0.4);
}

/** Detect MEV sandwich attack patterns */
function calcSandwichVictim(agentAddress: string, txs: EnhancedTransaction[]): number {
  if (txs.length < 5) return 0.3;

  const swaps = txs.filter((tx) => tx.type === 'SWAP');
  if (swaps.length === 0) return 0.1;

  let sandwichPatterns = 0;

  for (const swap of swaps) {
    const transfers = swap.tokenTransfers ?? [];

    // Pattern 1: Swap has unusually high slippage (>3%)
    if (transfers.length >= 2) {
      const inAmt = Math.abs(transfers[0]?.tokenAmount ?? 0);
      const outAmt = Math.abs(transfers[1]?.tokenAmount ?? 0);
      if (inAmt > 0 && outAmt > 0) {
        const slippage = 1 - Math.min(inAmt, outAmt) / Math.max(inAmt, outAmt);
        if (slippage > 0.03) sandwichPatterns++;
      }
    }

    // Pattern 2: Multiple token transfers in same tx beyond the agent's
    // (indicates frontrun/backrun bundled or close in time)
    const otherTransfers = transfers.filter(
      (t) => t.fromUserAccount !== agentAddress && t.toUserAccount !== agentAddress,
    );
    if (otherTransfers.length > 2) sandwichPatterns++;
  }

  // Ratio of potentially sandwiched swaps
  return clamp(sandwichPatterns / (swaps.length * 2));
}

// ── Protocol & DeFi Risk ────────────────────────────────────────────────────

/** Protocol concentration using Herfindahl-Hirschman Index */
function calcProtocolConcentration(txs: EnhancedTransaction[]): number {
  if (txs.length === 0) return 0.5;

  const programCounts = new Map<string, number>();

  for (const tx of txs) {
    for (const ix of tx.instructions ?? []) {
      if (ix.programId) {
        programCounts.set(ix.programId, (programCounts.get(ix.programId) ?? 0) + 1);
      }
    }
  }

  if (programCounts.size === 0) return 0.5;
  if (programCounts.size === 1) return 1.0;

  return normalizedHHI([...programCounts.values()]);
}

/** Score based on interaction with unverified/risky programs */
function calcRiskyProtocolExposure(txs: EnhancedTransaction[]): number {
  if (txs.length === 0) return 0.5;

  const allPrograms = new Set<string>();
  let riskyInteractions = 0;
  let totalInteractions = 0;

  // System programs that are always safe
  const safePrograms = new Set([
    '11111111111111111111111111111111', // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // ATA Program
    'ComputeBudget111111111111111111111111111111', // Compute Budget
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo v2
    'Memo1UhkJBfCR6MNB2EvFpvAtpnhkE5iFERCDREBU', // Memo v1
  ]);

  for (const tx of txs) {
    for (const ix of tx.instructions ?? []) {
      if (!ix.programId || safePrograms.has(ix.programId)) continue;

      totalInteractions++;
      allPrograms.add(ix.programId);

      // Check if this is a known DEX — these are safer
      if (KNOWN_DEX_PROGRAMS.has(ix.programId)) continue;

      // Bridge programs — riskier but known
      if (KNOWN_BRIDGE_PROGRAMS.has(ix.programId)) {
        riskyInteractions += 0.3;
        continue;
      }

      // Flash loan / leverage programs — risky
      if (FLASH_LOAN_PROGRAMS.has(ix.programId)) {
        riskyInteractions += 0.5;
        continue;
      }

      // Unknown programs — assign moderate risk
      riskyInteractions += 0.15;
    }
  }

  if (totalInteractions === 0) return 0.3;

  // Ratio of risky interactions, boosted by number of unknown programs
  const riskRatio = riskyInteractions / totalInteractions;
  const unknownProgramRatio = 1 - ([...allPrograms].filter(
    (p) => safePrograms.has(p) || KNOWN_DEX_PROGRAMS.has(p),
  ).length / allPrograms.size || 1);

  return clamp(riskRatio * 0.7 + unknownProgramRatio * 0.3);
}

/** DeFi operation complexity score (bridges, leverage, flash loans = higher) */
function calcDefiComplexity(txs: EnhancedTransaction[]): number {
  if (txs.length === 0) return 0.3;

  let complexityPoints = 0;
  const operationTypes = new Set<string>();

  for (const tx of txs) {
    const programs = (tx.instructions ?? []).map((ix) => ix.programId);
    const programSet = new Set(programs);

    // Detect operation types
    if (tx.type === 'SWAP') operationTypes.add('swap');
    if (tx.type === 'TRANSFER') operationTypes.add('transfer');

    // Bridge usage — high complexity
    for (const p of programSet) {
      if (KNOWN_BRIDGE_PROGRAMS.has(p)) {
        operationTypes.add('bridge');
        complexityPoints += 3;
      }
    }

    // Flash loan / leverage — very high complexity
    for (const p of programSet) {
      if (FLASH_LOAN_PROGRAMS.has(p)) {
        operationTypes.add('leverage');
        complexityPoints += 4;
      }
    }

    // Multi-hop swaps (many instructions in one tx)
    if (tx.type === 'SWAP' && (tx.instructions?.length ?? 0) > 4) {
      operationTypes.add('multi_hop');
      complexityPoints += 1;
    }

    // Complex txs with many inner instructions
    const innerIxCount = (tx.instructions ?? []).reduce(
      (sum, ix) => sum + (ix.innerInstructions?.length ?? 0), 0,
    );
    if (innerIxCount > 10) complexityPoints += 2;
  }

  // More diverse operation types = more complex
  const diversityScore = clamp(operationTypes.size / 6);

  // Complexity per transaction
  const avgComplexity = txs.length > 0 ? complexityPoints / txs.length : 0;
  const complexityScore = clamp(avgComplexity / 3);

  return clamp(diversityScore * 0.4 + complexityScore * 0.6);
}

// ── Wallet & Identity ───────────────────────────────────────────────────────

/** Wallet age risk: newer wallets are riskier */
function calcWalletAge(ageDays: number): number {
  // Non-linear curve: sharp risk drop-off in first 30 days, gradual after
  if (ageDays <= 0) return 1.0;
  if (ageDays < 7) return clamp(1.0 - ageDays * 0.04); // 7 days: 0.72
  if (ageDays < 30) return clamp(0.72 - (ageDays - 7) * 0.015); // 30 days: 0.375
  if (ageDays < 90) return clamp(0.375 - (ageDays - 30) * 0.003); // 90 days: 0.195
  if (ageDays < 365) return clamp(0.195 - (ageDays - 90) * 0.0005); // 365 days: 0.057
  return 0.05; // Established wallets — minimal age risk
}

/** SOL balance health — can the agent afford gas fees for operations? */
function calcSolBalanceHealth(nativeBalanceLamports: number, txs: EnhancedTransaction[]): number {
  const solBalance = nativeBalanceLamports / 1e9; // Convert lamports to SOL

  // Calculate average fee per transaction to estimate runway
  let avgFee = 0.000005; // Default ~5000 lamports
  if (txs.length > 0) {
    const totalFees = txs.reduce((sum, tx) => sum + (tx.fee ?? 0), 0);
    avgFee = totalFees / txs.length / 1e9;
  }

  const estimatedTxRunway = avgFee > 0 ? solBalance / avgFee : 0;

  // Risk thresholds:
  // < 0.01 SOL: critical (can't even do a few txs)
  // < 0.1 SOL: concerning
  // < 1 SOL: moderate
  // > 1 SOL: healthy
  if (solBalance < 0.01) return 0.95;
  if (solBalance < 0.05) return 0.75;
  if (solBalance < 0.1) return 0.55;
  if (solBalance < 0.5) return 0.35;
  if (solBalance < 1) return 0.2;

  // Also factor in runway
  const runwayScore = clamp(1 - estimatedTxRunway / 1000);

  return clamp(Math.min(0.1, runwayScore));
}

/** Concentration of funding sources — where did the money come from? */
function calcFundingSourceConcentration(agentAddress: string, txs: EnhancedTransaction[]): number {
  // Find all incoming transfers (both native SOL and tokens)
  const fundingSources = new Map<string, number>();

  for (const tx of txs) {
    // Native SOL transfers
    for (const transfer of tx.nativeTransfers ?? []) {
      if (transfer.toUserAccount === agentAddress && transfer.fromUserAccount !== agentAddress) {
        const current = fundingSources.get(transfer.fromUserAccount) ?? 0;
        fundingSources.set(transfer.fromUserAccount, current + transfer.amount);
      }
    }

    // Token transfers
    for (const transfer of tx.tokenTransfers ?? []) {
      if (transfer.toUserAccount === agentAddress && transfer.fromUserAccount !== agentAddress) {
        const current = fundingSources.get(transfer.fromUserAccount) ?? 0;
        fundingSources.set(transfer.fromUserAccount, current + Math.abs(transfer.tokenAmount));
      }
    }
  }

  if (fundingSources.size === 0) return 0.5;
  if (fundingSources.size === 1) return 0.9; // Single funding source — high concentration

  return normalizedHHI([...fundingSources.values()]);
}

// ── Portfolio Risk ──────────────────────────────────────────────────────────

/** Token concentration using proper HHI (Herfindahl-Hirschman Index).
 *  All amounts are normalized to their decimal-adjusted values so that
 *  SOL lamports (9 decimals) and USDC (6 decimals) are comparable. */
function calcTokenConcentration(tokens: TokenBalance[], nativeBalanceLamports: number): number {
  const amounts: number[] = [];

  // Normalize SOL: lamports → SOL (9 decimals)
  const solNormalized = nativeBalanceLamports / 1e9;
  if (solNormalized > 0) {
    amounts.push(solNormalized);
  }

  for (const token of tokens) {
    // Normalize each token by its own decimals
    const normalized = token.amount / (10 ** (token.decimals ?? 0));
    if (normalized > 0) {
      amounts.push(normalized);
    }
  }

  if (amounts.length <= 1) return amounts.length === 1 ? 0.9 : 0.5;

  return normalizedHHI(amounts);
}

/** Portfolio value risk — very small portfolios face higher risk */
function calcPortfolioValueRisk(tokens: TokenBalance[], nativeBalanceLamports: number): number {
  // Estimate total portfolio value in USDC terms
  // For non-USDC tokens we can't price without oracle, so count token positions
  let estimatedUsdcValue = 0;

  for (const token of tokens) {
    if (STABLECOIN_MINTS.has(token.mint)) {
      estimatedUsdcValue += token.amount / (10 ** token.decimals);
    }
  }

  // Native SOL rough estimate at $150 (conservative)
  const solValue = (nativeBalanceLamports / 1e9) * 150;
  estimatedUsdcValue += solValue;

  // Add a rough estimate for non-stablecoin tokens (counted at reduced value)
  const otherTokenCount = tokens.filter((t) => !STABLECOIN_MINTS.has(t.mint)).length;
  // Assume average of $10 per unique non-stable token holding (very conservative)
  estimatedUsdcValue += otherTokenCount * 10;

  // Risk thresholds:
  // < $10: very high risk (likely test/dust wallet)
  // < $100: high risk
  // < $1,000: moderate risk
  // < $10,000: low-moderate
  // > $10,000: low risk
  if (estimatedUsdcValue < 10) return 0.9;
  if (estimatedUsdcValue < 100) return 0.7;
  if (estimatedUsdcValue < 1000) return 0.45;
  if (estimatedUsdcValue < 10000) return 0.25;
  return 0.1;
}

/** Stablecoin ratio — lower stablecoin holdings = more volatile = riskier */
function calcStablecoinRatio(tokens: TokenBalance[]): number {
  if (tokens.length === 0) return 0.5;

  let stablecoinValue = 0;
  let totalValue = 0;

  for (const token of tokens) {
    const normalizedAmount = token.amount / (10 ** token.decimals);
    totalValue += normalizedAmount;
    if (STABLECOIN_MINTS.has(token.mint)) {
      stablecoinValue += normalizedAmount;
    }
  }

  if (totalValue === 0) return 0.5;

  const ratio = stablecoinValue / totalValue;

  // Higher stablecoin ratio = lower risk
  // 100% stable = 0.05 risk, 0% stable = 0.85 risk
  return clamp(0.85 - ratio * 0.8);
}

// ── Behavioral Patterns ─────────────────────────────────────────────────────

/** Activity regularity — erratic patterns suggest automated but buggy agents */
function calcActivityRegularity(txs: EnhancedTransaction[]): number {
  if (txs.length < 5) return 0.4;

  // Calculate inter-transaction intervals
  const sortedTxs = [...txs].sort((a, b) => a.timestamp - b.timestamp);
  const intervals: number[] = [];

  for (let i = 1; i < sortedTxs.length; i++) {
    intervals.push(sortedTxs[i]!.timestamp - sortedTxs[i - 1]!.timestamp);
  }

  if (intervals.length === 0) return 0.4;

  // Calculate coefficient of variation of intervals
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (mean === 0) return 0.3;

  const variance = intervals.reduce((sum, i) => sum + (i - mean) ** 2, 0) / intervals.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / mean;

  // Very regular (cv < 0.5): likely a bot with good scheduling = lower risk
  // Moderate (cv 0.5-2.0): normal mixed activity
  // Very irregular (cv > 2.0): erratic behavior = higher risk
  if (cv < 0.5) return 0.15;
  if (cv < 1.0) return 0.3;
  if (cv < 2.0) return 0.5;
  return clamp(0.5 + (cv - 2) * 0.1);
}

/** Recent risk trend — compare recent behavior to historical */
function calcRecentRiskTrend(txs: EnhancedTransaction[]): number {
  if (txs.length < 10) return 0.4;

  // Split into recent (first 30%) and historical (remaining 70%)
  const recentCount = Math.max(3, Math.floor(txs.length * 0.3));
  const recent = txs.slice(0, recentCount); // Helius returns newest first
  const historical = txs.slice(recentCount);

  if (historical.length === 0) return 0.4;

  // Compare failure rates
  const recentFailRate = recent.filter((tx) => tx.transactionError != null).length / recent.length;
  const historicalFailRate = historical.filter((tx) => tx.transactionError != null).length / historical.length;

  // Compare average tx complexity (instruction count)
  const recentAvgIx = recent.reduce((sum, tx) => sum + (tx.instructions?.length ?? 0), 0) / recent.length;
  const historicalAvgIx = historical.reduce((sum, tx) => sum + (tx.instructions?.length ?? 0), 0) / historical.length;

  // Trend scores: positive = worsening, negative = improving
  const failTrend = recentFailRate - historicalFailRate; // +0.3 means 30% more failures recently
  const complexityTrend = historicalAvgIx > 0
    ? (recentAvgIx - historicalAvgIx) / historicalAvgIx
    : 0;

  // Combine trends
  const combinedTrend = failTrend * 0.6 + clamp(complexityTrend) * 0.4;

  // Map to 0-1: negative trend (improving) = low risk, positive (worsening) = high risk
  return clamp(0.5 + combinedTrend);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC WEIGHT CALCULATION — confidence-adjusted
// ═══════════════════════════════════════════════════════════════════════════════

function calculateDynamicWeights(data: DataAvailability): FactorWeightInfo[] {
  return FACTOR_CONFIGS.map((config) => {
    const confidence = calculateFactorConfidence(config, data);
    const effectiveWeight = config.baseWeight * confidence;

    return {
      factor: config.key,
      category: config.category,
      baseWeight: config.baseWeight,
      confidence,
      effectiveWeight,
    };
  });
}

/** Calculate how confident we are in a specific factor based on available data */
function calculateFactorConfidence(config: FactorConfig, data: DataAvailability): number {
  const { key, minDataPoints } = config;

  // Map each factor to the data it depends on
  switch (key) {
    case 'failedTxRatio':
      return clamp(data.transactionCount / minDataPoints);
    case 'avgSlippage':
      return clamp(data.swapCount / minDataPoints);
    case 'txVelocityAnomaly':
      return clamp(data.transactionCount / minDataPoints);
    case 'sandwichVictim':
      return clamp(data.swapCount / minDataPoints);
    case 'protocolConcentration':
      return clamp(data.transactionCount / minDataPoints);
    case 'riskyProtocolExposure':
      return clamp(data.transactionCount / minDataPoints);
    case 'defiComplexity':
      return clamp(data.transactionCount / minDataPoints);
    case 'walletAge':
      return data.hasAccountInfo || data.transactionCount > 0 ? 1.0 : 0.3;
    case 'solBalanceHealth':
      return data.hasSolBalance ? 1.0 : 0.5;
    case 'fundingSourceConcentration':
      return clamp(data.incomingTxCount / minDataPoints);
    case 'tokenConcentration':
      return clamp(data.tokenCount / minDataPoints);
    case 'portfolioValueRisk':
      return data.tokenCount > 0 || data.hasSolBalance ? 0.8 : 0.3;
    case 'stablecoinRatio':
      return data.tokenCount > 0 ? 0.9 : 0.3;
    case 'activityRegularity':
      return clamp(data.transactionCount / minDataPoints);
    case 'recentRiskTrend':
      return clamp(data.transactionCount / minDataPoints);
    default:
      return 0.5;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY AGGREGATION
// ═══════════════════════════════════════════════════════════════════════════════

function buildCategoryRisks(factors: RiskFactors, weightInfo: FactorWeightInfo[]): CategoryRisk[] {
  const categories: RiskCategory[] = [
    'transaction_behavior',
    'protocol_defi',
    'wallet_identity',
    'portfolio',
    'behavioral_patterns',
  ];

  return categories.map((category) => {
    const catWeights = weightInfo.filter((w) => w.category === category);
    const totalWeight = catWeights.reduce((sum, w) => sum + w.effectiveWeight, 0);

    let score = 0;
    if (totalWeight > 0) {
      for (const w of catWeights) {
        score += factors[w.factor] * w.effectiveWeight;
      }
      score /= totalWeight;
    } else {
      score = 0.5;
    }

    return {
      category,
      label: CATEGORY_LABELS[category],
      score: Math.round(score * 1000) / 1000,
      weight: totalWeight,
      rating: valueToRating(score),
      factorCount: catWeights.length,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HUMAN-READABLE OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Compute a normalized Herfindahl-Hirschman Index from a list of amounts.
 *  Returns 0 for perfect diversity, 1 for complete concentration. */
function normalizedHHI(amounts: number[]): number {
  if (amounts.length <= 1) return amounts.length === 1 ? 1.0 : 0;
  const total = amounts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let hhi = 0;
  for (const a of amounts) {
    const share = a / total;
    hhi += share * share;
  }
  const minHHI = 1 / amounts.length;
  return clamp((hhi - minHHI) / (1 - minHHI || 1));
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

/** Compute wallet age in days from account info or earliest transaction */
function computeWalletAgeDays(
  accountInfo: AccountInfo | null,
  txs: EnhancedTransaction[],
): number {
  if (accountInfo?.createdAt) {
    return (Date.now() - new Date(accountInfo.createdAt).getTime()) / (1000 * 86400);
  }
  if (txs.length > 0) {
    const earliest = txs[txs.length - 1];
    if (earliest?.timestamp) {
      return (Date.now() / 1000 - earliest.timestamp) / 86400;
    }
  }
  return 0;
}

const FACTOR_DESCRIPTIONS: Record<keyof RiskFactors, {
  label: string;
  category: RiskCategory;
  describe: (value: number) => string;
}> = {
  failedTxRatio: {
    label: 'Transaction Failure Rate',
    category: 'transaction_behavior',
    describe: (v) =>
      v < 0.1 ? 'Very few failed transactions — agent executes reliably with strong error handling.'
      : v < 0.3 ? 'Some transaction failures detected, within normal range for DeFi operations.'
      : v < 0.6 ? `${pct(v)} of recent transactions failed (time-weighted) — suggests poor error handling or unstable protocol interactions.`
      : `${pct(v)} failure rate is critically high — agent may be malfunctioning or repeatedly hitting reverted states.`,
  },
  avgSlippage: {
    label: 'Swap Slippage',
    category: 'transaction_behavior',
    describe: (v) =>
      v < 0.15 ? 'Low slippage on swaps — agent uses appropriate trade sizes relative to pool liquidity.'
      : v < 0.4 ? 'Moderate slippage detected — some trades may exceed optimal size for available liquidity.'
      : `High average slippage (${pct(v)}) — agent may be trading in illiquid pools, using excessive size, or lacking slippage protection.`,
  },
  txVelocityAnomaly: {
    label: 'Transaction Velocity',
    category: 'transaction_behavior',
    describe: (v) =>
      v < 0.2 ? 'Consistent transaction pacing — no unusual activity spikes detected.'
      : v < 0.5 ? 'Some variation in transaction frequency — minor velocity fluctuations observed.'
      : `Significant velocity anomalies detected (${pct(v)}) — recent activity shows unusual spikes compared to historical baseline, which may indicate panic trading or a compromised agent.`,
  },
  sandwichVictim: {
    label: 'MEV Sandwich Exposure',
    category: 'transaction_behavior',
    describe: (v) =>
      v < 0.15 ? 'Low MEV exposure — swaps show healthy execution patterns with minimal sandwich attack indicators.'
      : v < 0.4 ? 'Moderate MEV exposure — some swap patterns suggest occasional sandwich attack vulnerability.'
      : `High MEV sandwich exposure (${pct(v)}) — agent\'s swap patterns indicate frequent value extraction by MEV bots, suggesting insufficient slippage protection or predictable trading patterns.`,
  },
  protocolConcentration: {
    label: 'Protocol Concentration',
    category: 'protocol_defi',
    describe: (v) =>
      v < 0.3 ? 'Well-diversified protocol interactions — activity spread across many programs reduces single-protocol risk.'
      : v < 0.6 ? 'Moderate protocol concentration — a few protocols dominate activity, creating some single-point exposure.'
      : `High protocol concentration (HHI: ${pct(v)}) — activity heavily concentrated in few protocols. A vulnerability in one could cause significant losses.`,
  },
  riskyProtocolExposure: {
    label: 'Risky Protocol Exposure',
    category: 'protocol_defi',
    describe: (v) =>
      v < 0.2 ? 'Interactions primarily with well-established, verified protocols — minimal exposure to unvetted programs.'
      : v < 0.5 ? 'Some interactions with lesser-known protocols detected — moderate unverified program exposure.'
      : `Significant risky protocol exposure (${pct(v)}) — frequent interactions with unverified or high-risk programs including bridges, flash loans, or unknown contracts.`,
  },
  defiComplexity: {
    label: 'DeFi Complexity',
    category: 'protocol_defi',
    describe: (v) =>
      v < 0.2 ? 'Simple DeFi operations — primarily basic swaps and transfers with low composability risk.'
      : v < 0.5 ? 'Moderate DeFi complexity — agent performs multi-step operations but within manageable risk bounds.'
      : `High DeFi complexity (${pct(v)}) — agent engages in advanced operations (bridges, leverage, multi-hop routing) that amplify risk through composability.`,
  },
  walletAge: {
    label: 'Wallet Maturity',
    category: 'wallet_identity',
    describe: (v) =>
      v < 0.15 ? 'Well-established wallet with a long on-chain history — strong track record reduces uncertainty.'
      : v < 0.4 ? 'Wallet has been active for several months — reasonable history for risk assessment.'
      : v < 0.7 ? 'Relatively new wallet — limited operational history increases assessment uncertainty.'
      : 'Very new wallet with minimal history — high uncertainty about agent behavior and reliability.',
  },
  solBalanceHealth: {
    label: 'SOL Balance Health',
    category: 'wallet_identity',
    describe: (v) =>
      v < 0.2 ? 'Healthy SOL balance — sufficient runway for gas fees across many operations.'
      : v < 0.5 ? 'Adequate SOL balance for near-term operations, but may need refilling soon.'
      : v < 0.8 ? 'Low SOL balance — agent may struggle to execute transactions, increasing failure risk.'
      : 'Critical SOL shortage — agent cannot reliably pay for gas fees, operations will fail.',
  },
  fundingSourceConcentration: {
    label: 'Funding Source Analysis',
    category: 'wallet_identity',
    describe: (v) =>
      v < 0.3 ? 'Diverse funding sources — wallet receives funds from multiple addresses, indicating healthy operational patterns.'
      : v < 0.6 ? 'Moderately concentrated funding — a few sources provide most of the wallet\'s capital.'
      : `Highly concentrated funding (${pct(v)} HHI) — wallet depends heavily on a single source, which creates counterparty risk and limits operational independence.`,
  },
  tokenConcentration: {
    label: 'Token Concentration',
    category: 'portfolio',
    describe: (v) =>
      v < 0.3 ? 'Well-diversified token holdings — HHI analysis shows balanced portfolio distribution.'
      : v < 0.6 ? 'Moderate token concentration — portfolio is somewhat skewed toward fewer assets.'
      : `High token concentration (HHI: ${pct(v)}) — portfolio heavily weighted in one or two tokens, creating significant price exposure risk.`,
  },
  portfolioValueRisk: {
    label: 'Portfolio Size',
    category: 'portfolio',
    describe: (v) =>
      v < 0.2 ? 'Substantial portfolio value — adequate capital base for the scale of operations performed.'
      : v < 0.5 ? 'Moderate portfolio size — sufficient for typical operations but may be strained by large positions.'
      : v < 0.8 ? 'Small portfolio — limited capital increases the impact of any single loss event.'
      : 'Very small or dust-level portfolio — minimal capital base makes any DeFi operation proportionally high-risk.',
  },
  stablecoinRatio: {
    label: 'Stablecoin Allocation',
    category: 'portfolio',
    describe: (v) =>
      v < 0.2 ? 'Strong stablecoin allocation — significant portion of holdings in stable assets reduces volatility exposure.'
      : v < 0.5 ? 'Moderate stablecoin holdings — reasonable balance between stable and volatile assets.'
      : v < 0.75 ? 'Low stablecoin allocation — portfolio is predominantly in volatile assets, increasing drawdown risk.'
      : 'Minimal or no stablecoin holdings — portfolio is fully exposed to token price volatility.',
  },
  activityRegularity: {
    label: 'Activity Regularity',
    category: 'behavioral_patterns',
    describe: (v) =>
      v < 0.2 ? 'Highly regular activity pattern — consistent scheduling suggests well-configured automated operations.'
      : v < 0.5 ? 'Moderately regular activity — some variation in timing but within expected ranges.'
      : v < 0.75 ? 'Irregular activity patterns — erratic timing between transactions may indicate instability.'
      : 'Highly erratic activity — unpredictable transaction timing suggests a poorly configured or unstable agent.',
  },
  recentRiskTrend: {
    label: 'Risk Trend Analysis',
    category: 'behavioral_patterns',
    describe: (v) =>
      v < 0.3 ? 'Improving risk trend — recent behavior shows fewer failures and simpler operations compared to history.'
      : v < 0.55 ? 'Stable risk profile — recent behavior is consistent with historical patterns.'
      : v < 0.75 ? 'Worsening risk trend — recent activity shows increased failures or complexity compared to baseline.'
      : 'Significantly deteriorating risk profile — recent behavior is substantially worse than historical average, suggesting emerging problems.',
  },
};

function buildFactorDetails(
  factors: RiskFactors,
  weightInfo: FactorWeightInfo[],
  _data: DataAvailability,
): FactorDetail[] {
  return FACTOR_CONFIGS.map((config) => {
    const value = factors[config.key];
    const desc = FACTOR_DESCRIPTIONS[config.key];
    const weight = weightInfo.find((w) => w.factor === config.key);

    return {
      factor: config.key,
      label: desc.label,
      value,
      rating: valueToRating(value),
      description: desc.describe(value),
      category: config.category,
      confidence: weight?.confidence ?? 0.5,
    };
  });
}

function buildSummary(
  score: number,
  tier: RiskTier,
  factors: RiskFactors,
  categoryRisks: CategoryRisk[],
  confidence: number,
): string {
  const topRiskCategories = categoryRisks
    .filter((c) => c.score > 0.5)
    .sort((a, b) => b.score - a.score);

  const topRiskFactors = (Object.entries(factors) as [keyof RiskFactors, number][])
    .filter(([, v]) => v > 0.6)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k]) => FACTOR_DESCRIPTIONS[k].label);

  const strengths = (Object.entries(factors) as [keyof RiskFactors, number][])
    .filter(([, v]) => v < 0.2)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 3)
    .map(([k]) => FACTOR_DESCRIPTIONS[k].label);

  let summary = `Risk score: ${score} (${TIER_LABELS[tier]}) — assessed across 15 factors in 5 categories with ${pct(confidence)} confidence.`;

  if (topRiskCategories.length > 0) {
    const catNames = topRiskCategories.slice(0, 2).map((c) => c.label);
    summary += ` Elevated risk in: ${catNames.join(', ')}.`;
  }

  if (topRiskFactors.length > 0) {
    summary += ` Key risk drivers: ${topRiskFactors.join(', ')}.`;
  }

  if (strengths.length > 0) {
    summary += ` Strengths: ${strengths.join(', ')}.`;
  }

  if (topRiskFactors.length === 0 && strengths.length > 0) {
    summary += ' No significant risk factors detected across all categories.';
  }

  return summary;
}

function buildRecommendation(
  tier: RiskTier,
  factors: RiskFactors,
  categoryRisks: CategoryRisk[],
): string {
  const worstCategory = categoryRisks.reduce((worst, c) =>
    c.score > worst.score ? c : worst,
  );

  switch (tier) {
    case RiskTier.LOW:
      return `This agent demonstrates a strong risk profile across all 5 assessment categories. Qualifies for the lowest premium tier (1% annual). Recommended for coverage up to the maximum limit. ${worstCategory.score > 0.3 ? `Minor note: "${worstCategory.label}" scored slightly higher at ${worstCategory.score.toFixed(2)} — worth monitoring but not concerning.` : ''}`;

    case RiskTier.MEDIUM: {
      const concerns: string[] = [];
      if (factors.failedTxRatio > 0.3) concerns.push('improving transaction success rate');
      if (factors.protocolConcentration > 0.5) concerns.push('diversifying protocol interactions');
      if (factors.walletAge > 0.5) concerns.push('building a longer operational track record');
      if (factors.tokenConcentration > 0.5) concerns.push('diversifying token holdings');
      if (factors.sandwichVictim > 0.3) concerns.push('implementing better MEV protection');
      if (factors.solBalanceHealth > 0.4) concerns.push('maintaining adequate SOL for gas');
      if (factors.stablecoinRatio > 0.5) concerns.push('increasing stablecoin allocation');
      const advice = concerns.length > 0 ? ` To reduce premiums, focus on: ${concerns.slice(0, 3).join('; ')}.` : '';
      return `Moderate risk profile — qualifies for insurance at 2.5% annual premium. Primary concern area: ${worstCategory.label} (score: ${worstCategory.score.toFixed(2)}).${advice}`;
    }

    case RiskTier.HIGH: {
      const issues: string[] = [];
      if (factors.failedTxRatio > 0.5) issues.push('high transaction failure rate');
      if (factors.avgSlippage > 0.5) issues.push('excessive swap slippage');
      if (factors.txVelocityAnomaly > 0.6) issues.push('erratic transaction velocity');
      if (factors.sandwichVictim > 0.5) issues.push('frequent MEV sandwich exposure');
      if (factors.riskyProtocolExposure > 0.5) issues.push('risky protocol interactions');
      if (factors.defiComplexity > 0.6) issues.push('high-complexity DeFi operations');
      if (factors.recentRiskTrend > 0.6) issues.push('worsening risk trend');
      const detail = issues.length > 0 ? ` Critical issues: ${issues.join(', ')}.` : '';
      return `Elevated risk profile across multiple categories. Insurance available at 5% annual premium, reflecting higher loss probability.${detail} Immediate attention recommended on "${worstCategory.label}" category.`;
    }

    case RiskTier.EXTREME:
      return `This agent exceeds acceptable risk thresholds and is currently NOT eligible for insurance coverage. The 15-factor analysis reveals critical risk signals across ${categoryRisks.filter((c) => c.score > 0.6).length} of 5 categories. Worst category: ${worstCategory.label} (${worstCategory.score.toFixed(2)}). The agent should: reduce failed transactions, implement MEV protection, diversify protocol usage, increase stablecoin holdings, and establish a longer operational history before reapplying.`;
  }
}
