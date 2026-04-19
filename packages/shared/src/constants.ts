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
  VAULT: 'covantic_vault',
  POLICY: 'covantic_policy',
  STAKER: 'covantic_staker',
  CONFIG: 'covantic_config',
  VAULT_TOKEN: 'covantic_vault_token',
  /** One attestation PDA per agent address. See program state/risk_attestation.rs. */
  ATTESTATION: 'covantic_attestation',
} as const;

/**
 * Maximum validity window for a risk attestation (seconds). Keep in sync
 * with `MAX_ATTESTATION_VALIDITY` in the Anchor program.
 */
export const ATTESTATION_MAX_VALIDITY_SECONDS = 3600;

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

/** Lock periods per trigger type in seconds. Must stay in sync with
 *  `LOCK_*` constants in the Anchor program. A zero lock is unsafe: the
 *  lock is the only buffer between a claim submission and payout if the
 *  oracle key is compromised. */
export const LOCK_PERIODS = {
  EXPLOIT: 3600, // 1 hour
  ORACLE_MANIPULATION: 3600, // 1 hour
  AGENT_ERROR: 21600, // 6 hours
  GOVERNANCE_ATTACK: 7200, // 2 hours
} as const;

/** Base58 Solana transaction signature regex (87–88 chars, Base58 alphabet). */
export const SOLANA_SIGNATURE_REGEX = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

/**
 * Canonical SPL Memo v2 program ID. Stable across mainnet-beta, devnet,
 * and testnet; used by the fleet runner to produce deliberately-failing
 * transactions (non-UTF-8 payload → `InstructionError::InvalidInstructionData`)
 * without having to deploy additional programs.
 */
export const SPL_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Solana's maximum serialized transaction size in bytes (PACKET_DATA_SIZE).
 * Used as a safety bound when the fleet generates instruction payloads —
 * exceeding it throws client-side in web3.js `Transaction.serialize()` and
 * the tx never reaches the cluster.
 */
export const MAX_TX_BYTES = 1232;

/** Synthetic demo payout ratio (80% of coverage) used by the simulated
 *  pipeline to mirror the marketing animation. Production verifiers derive
 *  payout from actual loss, not this ratio. */
export const SYNTHETIC_PAYOUT_RATIO = 0.8;

/** Prefix used on placeholder transaction signatures generated for
 *  demo/simulation flows. Real Base58 signatures never match. */
export const DEMO_TX_SIGNATURE_PREFIX = 'demo_';

/** Generate a demo tx signature for simulated monitoring events.
 *  Detected downstream via {@link DEMO_TX_SIGNATURE_PREFIX}. */
export function generateDemoTxSignature(): string {
  return `${DEMO_TX_SIGNATURE_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Maximum active policies per wallet */
export const MAX_POLICIES_PER_WALLET = 10;

/** Risk score tier boundaries */
export const RISK_SCORE_BOUNDARIES = {
  LOW_MAX: 0.3,
  MEDIUM_MAX: 0.6,
  HIGH_MAX: 0.85,
} as const;

/** Base58 Solana address regex (32-44 chars from the base58 alphabet). */
export const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Encode a u64 policy_id into an 8-byte little-endian buffer, matching the
 * on-chain `&policy.policy_id.to_le_bytes()` seed. Accepts bigint or any
 * object with a `toString()` (e.g. anchor BN) so BN-using callers don't
 * need to import @coral-xyz/anchor just to call this.
 */
export function policyIdToBytes(id: bigint | { toString(): string }): Uint8Array {
  const value = typeof id === 'bigint' ? id : BigInt(id.toString());
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, value, true);
  return buf;
}
