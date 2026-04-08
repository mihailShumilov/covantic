import { RiskTier } from './types/policy.js';
import { SolvencyStatus } from './types/vault.js';
import { PREMIUM_BPS, RISK_SCORE_BOUNDARIES, SOLVENCY_THRESHOLDS, DURATION } from './constants.js';

/** Calculate premium amount in USDC lamports */
export function calculatePremium(
  coverageAmount: number,
  durationSeconds: number,
  riskTier: RiskTier,
  premiumMultiplierBps: number = 10000,
): number {
  const bps = tierToPremiumBps(riskTier);
  if (bps < 0) return -1; // EXTREME — not insurable

  const annualPremium = (coverageAmount * bps) / 10000;
  const durationFraction = durationSeconds / (365 * 24 * 3600);
  let premium = Math.round(annualPremium * durationFraction);

  // Apply multiplier (e.g. caution mode = 12500 bps = 1.25x)
  premium = Math.round((premium * premiumMultiplierBps) / 10000);

  // Minimum premium: 0.001 USDC = 1000 lamports
  return Math.max(premium, 1000);
}

/** Map risk tier to premium basis points */
export function tierToPremiumBps(tier: RiskTier): number {
  switch (tier) {
    case RiskTier.LOW:
      return PREMIUM_BPS.LOW;
    case RiskTier.MEDIUM:
      return PREMIUM_BPS.MEDIUM;
    case RiskTier.HIGH:
      return PREMIUM_BPS.HIGH;
    case RiskTier.EXTREME:
      return -1; // Not insurable
  }
}

/** Map risk score (0-1) to risk tier */
export function scoreToTier(score: number): RiskTier {
  if (score <= RISK_SCORE_BOUNDARIES.LOW_MAX) return RiskTier.LOW;
  if (score <= RISK_SCORE_BOUNDARIES.MEDIUM_MAX) return RiskTier.MEDIUM;
  if (score <= RISK_SCORE_BOUNDARIES.HIGH_MAX) return RiskTier.HIGH;
  return RiskTier.EXTREME;
}

/** Determine solvency status from ratio (basis points) */
export function solvencyStatus(ratioBps: number): SolvencyStatus {
  if (ratioBps >= SOLVENCY_THRESHOLDS.HEALTHY) return SolvencyStatus.Healthy;
  if (ratioBps >= SOLVENCY_THRESHOLDS.CAUTION) return SolvencyStatus.Caution;
  if (ratioBps >= SOLVENCY_THRESHOLDS.CRITICAL) return SolvencyStatus.Critical;
  return SolvencyStatus.Emergency;
}

/** Format USDC lamports as human-readable string */
export function formatUsdc(lamports: number): string {
  const amount = lamports / 1_000_000;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format duration in seconds to human-readable string */
export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** Validate policy duration is within limits */
export function isValidDuration(seconds: number): boolean {
  return seconds >= DURATION.MIN && seconds <= DURATION.MAX;
}

/** Shorten a Solana address for display: "7nYB...3kTz" */
export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
