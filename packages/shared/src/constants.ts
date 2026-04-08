/** USDC token decimals */
export const USDC_DECIMALS = 6;

/** Convert USDC amount to lamports (6 decimals) */
export function usdcToLamports(amount: number): number {
  return Math.round(amount * 10 ** USDC_DECIMALS);
}

/** Convert USDC lamports to human-readable amount */
export function lamportsToUsdc(lamports: number): number {
  return lamports / 10 ** USDC_DECIMALS;
}

/** PDA seeds */
export const PDA_SEEDS = {
  VAULT: 'vault',
  POLICY: 'policy',
  STAKER: 'staker',
  CONFIG: 'config',
  VAULT_TOKEN: 'vault_token',
} as const;

/** Coverage limits in USDC lamports */
export const COVERAGE = {
  MIN: 1_000_000, // 1 USDC
  MAX: 1_000_000_000_000, // 1,000,000 USDC
} as const;

/** Policy duration limits in seconds */
export const DURATION = {
  MIN: 3600, // 1 hour
  MAX: 30 * 24 * 3600, // 30 days
} as const;

/** Premium rates in basis points by risk tier */
export const PREMIUM_BPS = {
  LOW: 100, // 1%
  MEDIUM: 250, // 2.5%
  HIGH: 500, // 5%
} as const;

/** Premium distribution shares (basis points, sum = 10000) */
export const PREMIUM_SPLIT = {
  STAKERS: 7000, // 70%
  RESERVE: 2000, // 20%
  PROTOCOL: 1000, // 10%
} as const;

/** Solvency ratio thresholds (basis points) */
export const SOLVENCY_THRESHOLDS = {
  HEALTHY: 20000, // 2.0x
  CAUTION: 10000, // 1.0x — +25% premiums
  CRITICAL: 5000, // 0.5x — pause HIGH-risk policies
  EMERGENCY: 0, // pause ALL new policies
} as const;

/** Unstake cooldown period in seconds (48 hours) */
export const UNSTAKE_COOLDOWN = 48 * 3600;

/** Lock periods per trigger type in seconds */
export const LOCK_PERIODS = {
  EXPLOIT: 0, // Immediate payout
  ORACLE_MANIPULATION: 3600, // 1 hour
  AGENT_ERROR: 21600, // 6 hours
  GOVERNANCE_ATTACK: 7200, // 2 hours
} as const;

/** Maximum active policies per wallet */
export const MAX_POLICIES_PER_WALLET = 10;

/** Risk score tier boundaries */
export const RISK_SCORE_BOUNDARIES = {
  LOW_MAX: 0.3,
  MEDIUM_MAX: 0.6,
  HIGH_MAX: 0.85,
} as const;
