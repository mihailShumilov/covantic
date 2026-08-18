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

/// Seed for RiskAttestation PDA — one per agent address.
pub const ATTESTATION_SEED: &[u8] = b"covantic_attestation";

/// Maximum validity window for a risk attestation (1 hour). The oracle may
/// refresh more often; this is the upper bound so a compromised oracle key
/// cannot mint long-lived attestations that survive a rotation.
pub const MAX_ATTESTATION_VALIDITY: i64 = 3600;

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

/// Seed for the ClaimEvidenceRecord PDA — one per policy.
pub const CLAIM_EVIDENCE_SEED: &[u8] = b"covantic_claim_evidence";

/// Exponent every price evidence submission must use.
///
/// Pyth publishes USD feeds at 1e-8. Pinning it means the program never has
/// to rescale between the signed price and the committed execution, and a
/// mismatched exponent — the classic way to be wrong by a factor of a
/// hundred million — is rejected instead of silently accepted.
pub const PRICE_EVIDENCE_EXPO: i32 = -8;

/// How far the signed price may sit from the transaction it is pricing.
///
/// Pyth publishes several times a second, so a legitimate lookup lands within
/// a second or two. Anything wider is pricing the trade against a different
/// moment in the market.
pub const MAX_PRICE_EVIDENCE_SKEW: i64 = 5;

/// Oldest a trigger transaction may be relative to the claim filed for it.
///
/// Bounds how far back the oracle may reach for a favourable price. Seven
/// days is generous for an automated pipeline that files within minutes,
/// while still ruling out mining the historical record for a moment when
/// some feed happened to dislocate.
pub const MAX_CLAIM_EVIDENCE_LAG: i64 = 7 * 24 * 3600;

/// Smallest deviation that can support a proven payout, in basis points.
///
/// Mirrors the off-chain floor. Its job here is different, though: off chain
/// it filters noise, while on chain it is a hard limit on what a compromised
/// oracle key can extract from a normal, honest fill.
pub const MIN_PROVABLE_DEVIATION_BPS: u32 = 50;

/// Upper bound on subject token decimals, so the scaling exponent cannot be
/// driven somewhere that overflows.
pub const MAX_SUBJECT_DECIMALS: u8 = 18;
