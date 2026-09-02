import { RiskTier } from './types/policy.js';
import { SolvencyStatus } from './types/vault.js';
import { PREMIUM_BPS, RISK_SCORE_BOUNDARIES, SOLVENCY_THRESHOLDS, DURATION } from './constants.js';

/**
 * Calculate premium amount in USDC lamports. Returns `null` for uninsurable
 * (EXTREME) tiers — callers must check before using the value.
 */
/**
 * @param envelopeFlatPremium what the declared deductible costs, as a flat
 * amount in the covered mint's base units. Added *after* the duration scaling,
 * exactly as `create_policy` does — the quote and the chain have to agree on
 * the price or the holder is shown one number and charged another.
 *
 * Flat rather than a rate because the thing it prices — the amount a holder
 * can extract at will — exists from the first minute of the policy instead of
 * accruing over its life. As a rate it divided by the tenor, and a one-hour
 * policy bought an ability worth the whole coverage for a fraction of a
 * percent of it.
 */
export function calculatePremium(
  coverageAmount: number,
  durationSeconds: number,
  riskTier: RiskTier,
  premiumMultiplierBps: number = 10000,
  envelopeFlatPremium: number = 0,
): number | null {
  const bps = tierToPremiumBps(riskTier);
  if (bps == null) return null;

  const annualPremium = (coverageAmount * bps) / 10000;
  const durationFraction = durationSeconds / (365 * 24 * 3600);
  let premium = Math.round(annualPremium * durationFraction);

  premium = Math.round((premium * premiumMultiplierBps) / 10000);

  // After the duration scaling, and deliberately outside the floor below: the
  // envelope's price is an amount, not a rate, and the order here has to match
  // `create_policy` exactly or the quote and the chain disagree.
  premium += envelopeFlatPremium;

  return Math.max(premium, 1000);
}

/** Map risk tier to premium basis points. `null` for EXTREME (uninsurable). */
export function tierToPremiumBps(tier: RiskTier): number | null {
  switch (tier) {
    case RiskTier.LOW:
      return PREMIUM_BPS.LOW;
    case RiskTier.MEDIUM:
      return PREMIUM_BPS.MEDIUM;
    case RiskTier.HIGH:
      return PREMIUM_BPS.HIGH;
    case RiskTier.EXTREME:
      return null;
  }
}

/** True when a tier can be priced and quoted for a policy. */
export function isInsurableTier(tier: RiskTier): boolean {
  return tierToPremiumBps(tier) != null;
}

/** Human-readable labels for risk tiers, indexed by RiskTier enum value.
 *  The `& Record<number, string>` allows indexing by plain `number` when the
 *  tier comes from an API response that hasn't been narrowed to `RiskTier`. */
export const TIER_LABELS: Record<RiskTier, string> & Record<number, string> = {
  [RiskTier.LOW]: 'LOW',
  [RiskTier.MEDIUM]: 'MEDIUM',
  [RiskTier.HIGH]: 'HIGH',
  [RiskTier.EXTREME]: 'EXTREME',
};

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

/**
 * Format USDC base units as a human-readable string.
 *
 * Two decimals, with one exception: an amount that is not zero never renders
 * as `0.00`. A short policy on small coverage costs a fraction of a cent —
 * 100 USDC for 24 hours at the LOW tier is 2,740 base units, $0.00274 — and
 * showing that as `$0.00` hides both the number and the fact that there is
 * one, on the screen where someone is deciding whether to pay it. Six
 * decimals is USDC's own precision, so it is the most that can be shown.
 */
export function formatUsdc(lamports: number): string {
  const amount = lamports / 1_000_000;
  const roundsToZero = amount !== 0 && Math.abs(amount) < 0.005;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: roundsToZero ? 6 : 2,
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
