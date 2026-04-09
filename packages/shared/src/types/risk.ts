import type { RiskTier } from './policy.js';

/** Individual risk factor scores (0.0 - 1.0, higher = riskier) */
export interface RiskFactors {
  failedRatio: number;
  avgSlippage: number;
  protocolDiversity: number;
  walletAge: number;
  registryScore: number;
  tokenConcentration: number;
  txVolume: number;
}

/** Human-readable description of a single risk factor */
export interface FactorDetail {
  label: string;
  value: number;
  rating: 'low' | 'moderate' | 'elevated' | 'high';
  description: string;
}

/** Complete risk assessment result */
export interface RiskAssessment {
  score: number;
  tier: RiskTier;
  premiumBps: number;
  factors: RiskFactors;
  factorDetails: FactorDetail[];
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
