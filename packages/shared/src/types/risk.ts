import type { RiskTier } from './policy.js';

/** Risk assessment category for grouping factors */
export type RiskCategory =
  | 'transaction_behavior'
  | 'protocol_defi'
  | 'wallet_identity'
  | 'portfolio'
  | 'behavioral_patterns';

/** Individual risk factor scores (0.0 - 1.0, higher = riskier) */
export interface RiskFactors {
  // ── Transaction Behavior ──────────────────────────────────
  /** Ratio of failed transactions to total (time-weighted, recent failures weigh more) */
  failedTxRatio: number;
  /** Average slippage on swap transactions (normalized) */
  avgSlippage: number;
  /** Sudden spikes in transaction velocity vs historical baseline */
  txVelocityAnomaly: number;
  /** Frequency of being sandwiched in MEV attacks */
  sandwichVictim: number;

  // ── Protocol & DeFi Risk ──────────────────────────────────
  /** Concentration in few protocols (inverse diversity) */
  protocolConcentration: number;
  /** Interaction with unverified/risky/new programs */
  riskyProtocolExposure: number;
  /** Complexity of DeFi operations (bridges, leverage, flash loans) */
  defiComplexity: number;

  // ── Wallet & Identity ─────────────────────────────────────
  /** Wallet age and maturity (newer = riskier) */
  walletAge: number;
  /** SOL balance health — can the agent afford gas fees? */
  solBalanceHealth: number;
  /** Concentration of funding from few sources */
  fundingSourceConcentration: number;

  // ── Portfolio Risk ────────────────────────────────────────
  /** HHI-based token concentration (single-token exposure) */
  tokenConcentration: number;
  /** Portfolio size risk (very small portfolios = higher risk) */
  portfolioValueRisk: number;
  /** Ratio of stablecoins to total (lower stablecoin = riskier) */
  stablecoinRatio: number;

  // ── Behavioral Patterns ───────────────────────────────────
  /** Regularity of activity (erratic patterns = riskier) */
  activityRegularity: number;
  /** Recent trend — is risk profile worsening? */
  recentRiskTrend: number;
}

/** Metadata about a single factor's weight and confidence */
export interface FactorWeightInfo {
  factor: keyof RiskFactors;
  category: RiskCategory;
  baseWeight: number;
  confidence: number;
  effectiveWeight: number;
}

/** Human-readable description of a single risk factor */
export interface FactorDetail {
  factor: keyof RiskFactors;
  label: string;
  value: number;
  rating: 'low' | 'moderate' | 'elevated' | 'high';
  description: string;
  category: RiskCategory;
  confidence: number;
}

/** Category-level risk summary */
export interface CategoryRisk {
  category: RiskCategory;
  label: string;
  score: number;
  weight: number;
  rating: 'low' | 'moderate' | 'elevated' | 'high';
  factorCount: number;
}

/** Data availability metrics for confidence calculation */
export interface DataAvailability {
  transactionCount: number;
  swapCount: number;
  tokenCount: number;
  hasAccountInfo: boolean;
  walletAgeDays: number;
  hasSolBalance: boolean;
  incomingTxCount: number;
}

/** Complete risk assessment result */
export interface RiskAssessment {
  score: number;
  tier: RiskTier;
  premiumBps: number;
  factors: RiskFactors;
  factorDetails: FactorDetail[];
  categoryRisks: CategoryRisk[];
  weightInfo: FactorWeightInfo[];
  dataAvailability: DataAvailability;
  overallConfidence: number;
  summary: string;
  recommendation: string;
  assessedAt: Date;
}

/** Agent information with risk data */
export interface Agent {
  id: string;
  walletAddress: string;
  ownerAddress: string;
  name: string | null;
  description: string | null;
  riskScore: number | null;
  riskTier: RiskTier | null;
  riskScoredAt: Date | null;
  totalTransactions: number;
  failedTransactions: number;
  protocolsUsed: number;
  walletAgeDays: number;
}
