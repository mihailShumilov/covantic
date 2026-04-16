/// Seed for InsuranceVault PDA
pub const VAULT_SEED: &[u8] = b"covantic_vault";

/// Seed for InsurancePolicy PDA
pub const POLICY_SEED: &[u8] = b"covantic_policy";

/// Seed for StakerPosition PDA
pub const STAKER_SEED: &[u8] = b"covantic_staker";

/// Seed for ProtocolConfig PDA
pub const CONFIG_SEED: &[u8] = b"covantic_config";

/// Seed for vault token account PDA
pub const VAULT_TOKEN_SEED: &[u8] = b"covantic_vault_token";

/// Maximum coverage amount in USDC (6 decimals): 1,000,000 USDC
pub const MAX_COVERAGE_AMOUNT: u64 = 1_000_000_000_000;

/// Minimum coverage amount: 1 USDC
pub const MIN_COVERAGE_AMOUNT: u64 = 1_000_000;

/// Minimum policy duration: 1 hour (3600 seconds)
pub const MIN_POLICY_DURATION: i64 = 3600;

/// Maximum policy duration: 30 days
pub const MAX_POLICY_DURATION: i64 = 30 * 24 * 3600;

/// Premium basis points by tier:
/// LOW = 100 bps (1%), MEDIUM = 250 bps (2.5%), HIGH = 500 bps (5%)
pub const PREMIUM_BPS_LOW: u16 = 100;
pub const PREMIUM_BPS_MEDIUM: u16 = 250;
pub const PREMIUM_BPS_HIGH: u16 = 500;

/// Premium distribution (basis points, sum = 10000):
/// 70% stakers, 20% reserve, 10% protocol
pub const STAKER_SHARE_BPS: u16 = 7000;
pub const RESERVE_SHARE_BPS: u16 = 2000;
pub const PROTOCOL_SHARE_BPS: u16 = 1000;

/// Solvency ratio thresholds (basis points):
/// Healthy: > 20000 (2.0x)
/// Caution: 10000-20000 (1.0x-2.0x) — +25% premiums
/// Critical: 5000-10000 (0.5x-1.0x) — pause HIGH-risk policies
/// Emergency: < 5000 (0.5x) — pause ALL new policies
pub const SOLVENCY_HEALTHY: u16 = 20000;
pub const SOLVENCY_CAUTION: u16 = 10000;
pub const SOLVENCY_CRITICAL: u16 = 5000;

/// Cooldown for unstake: 48 hours
pub const UNSTAKE_COOLDOWN: i64 = 48 * 3600;

/// Risk tier enum values
pub const RISK_TIER_LOW: u8 = 0;
pub const RISK_TIER_MEDIUM: u8 = 1;
pub const RISK_TIER_HIGH: u8 = 2;

/// Trigger type enum values
pub const TRIGGER_NONE: u8 = 0;
pub const TRIGGER_EXPLOIT: u8 = 1;
pub const TRIGGER_ORACLE_MANIPULATION: u8 = 2;
pub const TRIGGER_AGENT_ERROR: u8 = 3;
pub const TRIGGER_GOVERNANCE_ATTACK: u8 = 4;

/// Lock periods for trigger types (seconds). The lock is the on-chain
/// buffer between claim submission and payout, giving the admin time to
/// pause the protocol if the oracle is compromised. MUST be > 0 for every
/// trigger type or a compromised oracle keypair can drain the vault in a
/// single slot with no chance of intervention.
pub const LOCK_EXPLOIT: i64 = 3600;
pub const LOCK_ORACLE_MANIPULATION: i64 = 3600;
pub const LOCK_AGENT_ERROR: i64 = 21600;
pub const LOCK_GOVERNANCE_ATTACK: i64 = 7200;

/// USDC decimals
pub const USDC_DECIMALS: u8 = 6;

/// Maximum active policies per wallet
pub const MAX_POLICIES_PER_WALLET: u8 = 10;

/// Seconds in a year (for premium calculation)
pub const SECONDS_PER_YEAR: i64 = 365 * 24 * 3600;

/// Minimum premium: 0.001 USDC = 1000 lamports
pub const MIN_PREMIUM: u64 = 1000;

/// Default premium multiplier (no adjustment) in bps
pub const DEFAULT_PREMIUM_MULTIPLIER: u16 = 10000;

/// Caution mode premium multiplier: +25% = 12500 bps
pub const CAUTION_PREMIUM_MULTIPLIER: u16 = 12500;

/// Cancellation penalty: 20%
pub const CANCEL_PENALTY_BPS: u16 = 2000;

/// Maximum length of the stored trigger transaction signature.
/// Signatures are persisted as Base58-encoded UTF-8 bytes (87-88 chars).
/// 88 leaves a 1-byte pad for future-proofing.
pub const MAX_TRIGGER_TX_SIG_LEN: usize = 88;
