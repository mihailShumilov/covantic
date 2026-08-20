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

/// Seed for the PolicyBalanceCheckpoint PDA — one per policy.
pub const CHECKPOINT_SEED: &[u8] = b"covantic_checkpoint";

/// Seed for the ExploitEvidenceRecord PDA — one per policy.
pub const EXPLOIT_EVIDENCE_SEED: &[u8] = b"covantic_exploit_evidence";

/// Oldest a checkpoint may be and still describe "before the incident".
///
/// The crank runs every couple of minutes, so a healthy checkpoint is minutes
/// old. Two hours is generous enough to survive a worker outage while still
/// ruling out measuring a drain against a balance from a different afternoon.
/// This bound *is* the exposure window of the whole mechanism: a drain that
/// happens and is claimed with no checkpoint newer than this cannot be proven
/// here, and goes to review instead.
pub const MAX_CHECKPOINT_AGE: i64 = 2 * 3600;

/// Smallest drop that can support a proven exploit payout, in basis points.
///
/// 5,000 bps is the "balance drop >50% in a single slot" the product has
/// advertised since launch, enforced here for the first time. Its job on
/// chain differs from the off-chain screen's: off chain a ratio decides what
/// is worth verifying, while here it is a hard limit on what a compromised
/// oracle key can extract from an agent that merely spent some money.
pub const MIN_PROVABLE_DROP_BPS: u32 = 5_000;

/// Seed for the GovernanceBaseline PDA — one per policy.
pub const GOVERNANCE_BASELINE_SEED: &[u8] = b"covantic_gov_baseline";

/// Seed for the PolicyAuthorityCheckpoint PDA — one per policy.
pub const AUTHORITY_CHECKPOINT_SEED: &[u8] = b"covantic_authority_checkpoint";

/// Seed for the GovernanceEvidenceRecord PDA — one per policy.
pub const GOVERNANCE_EVIDENCE_SEED: &[u8] = b"covantic_gov_evidence";

/// How many extra addresses a holder may declare as legitimate controllers,
/// beyond the named roles. Fixed so the account's size — and the stack cost
/// of loading it — are bounded.
pub const MAX_GOVERNANCE_EXTRA_AUTHORITIES: usize = 4;

/// How long a governance baseline must sit before it can support a claim.
///
/// This delay is the mechanism, not a formality. A declaration that could be
/// written and claimed against in the same transaction would prove nothing: a
/// stolen holder key would simply declare a convenient one first. An hour
/// forces a fraudulent claim to pre-commit on chain, publicly, well before
/// the incident it is meant to justify.
pub const GOVERNANCE_BASELINE_DELAY: i64 = 3600;

/// Oldest an authority checkpoint may be, **measured at the moment the claim
/// was filed**, and still describe "before the takeover".
///
/// Same role and same value as `MAX_CHECKPOINT_AGE` on the balance path, and
/// deliberately the same number: the two readings are written by one crank on
/// one tick, and giving them different staleness allowances would let a
/// payout be proven against a "before" that meant two different moments.
///
/// The *reference point* differs, though, and has to. `verify_and_payout_
/// exploit` compares the checkpoint against `now`, which silently folds its
/// one-hour lock into the allowance; that leaves an hour of slack and works.
/// This trigger's lock is two hours — the whole allowance — so the same
/// comparison would make every governance payout unsatisfiable. The bound is
/// therefore measured against `policy.claim_submitted_at`, which is also the
/// question actually worth asking: how stale was the reading when the
/// incident happened, not how long settlement subsequently took.
pub const MAX_AUTHORITY_CHECKPOINT_AGE: i64 = 2 * 3600;

/// How long after a takeover a loss still counts as part of it.
///
/// The 30 minutes the coverage table has advertised since launch. Worth being
/// honest about what it does: it bounds the *provable* conjunction. A drain
/// that lands later is not denied — it goes to a reviewer, because two
/// readings that far apart cannot establish that this takeover caused it.
pub const GOVERNANCE_DRAIN_WINDOW: i64 = 30 * 60;

/// Smallest value that can support a proven governance payout, in USDC base
/// units (1 USDC).
///
/// Off chain a floor filters noise; here its job is different. It is a hard
/// limit on what a compromised oracle key can extract by pointing this
/// instruction at an agent whose empty account happens to have changed hands.
pub const MIN_PROVABLE_GOVERNANCE_LOSS: u64 = 1_000_000;

/// Seed for the PolicyAgentMandate PDA — one per policy.
pub const AGENT_MANDATE_SEED: &[u8] = b"covantic_agent_mandate";

/// Seed for the AgentErrorEvidenceRecord PDA — one per policy.
pub const AGENT_ERROR_EVIDENCE_SEED: &[u8] = b"covantic_agent_error_evidence";

/// How long an agent mandate must sit before it can support a claim.
///
/// Same value and same mechanism as `GOVERNANCE_BASELINE_DELAY`, and a
/// separate constant because the two answer different questions — who may
/// control the agent, and what the agent may do — and one may need retuning
/// without the other.
///
/// The delay is what stops the obvious abuse. Without it a holder could watch
/// an ordinary loss happen and then declare, retroactively, a mandate narrow
/// enough to have been breached by it. With it, that manoeuvre has to be
/// committed to on chain, in public, an hour before an incident the holder
/// must then arrange to happen.
pub const MANDATE_DECLARATION_DELAY: i64 = 3600;

/// How many destinations a holder may declare as permitted for their agent.
/// Fixed so the account's size — and the stack cost of loading it — are
/// bounded.
pub const MAX_MANDATE_COUNTERPARTIES: usize = 8;

/// How many programs a holder may declare as permitted. Same reason.
pub const MAX_MANDATE_PROGRAMS: usize = 8;

/// Smallest mandate breach that can support a proven agent-error payout, in
/// USDC base units.
///
/// Off chain a floor filters noise; here its job is different. It is a hard
/// limit on what a compromised oracle key can extract by pointing this
/// instruction at a policy whose agent merely spent slightly more than its
/// declared cap.
pub const MIN_PROVABLE_MANDATE_BREACH: u64 = 1_000_000;

/// Oldest a balance checkpoint may be, **measured at the moment the claim was
/// filed**, and still describe "before the breach".
///
/// Same value as `MAX_CHECKPOINT_AGE` and `MAX_AUTHORITY_CHECKPOINT_AGE`: all
/// three readings come off one crank on one tick, and giving them different
/// allowances would let a payout be proven against a "before" that meant
/// different moments.
///
/// The *reference point* is `policy.claim_submitted_at`, following the
/// governance path rather than the exploit one, and here that is not a
/// refinement but a necessity. `verify_and_payout_exploit` compares against
/// `now`, which silently folds its one-hour lock into a two-hour allowance
/// and leaves an hour of slack. `LOCK_AGENT_ERROR` is six hours — three times
/// the entire allowance — so the same comparison would make **every**
/// agent-error payout unsatisfiable, not merely fragile. Do not "align" this
/// with the exploit path.
pub const MAX_MANDATE_CHECKPOINT_AGE: i64 = 2 * 3600;

/// How control left the declared set. Recorded on the evidence account so a
/// reader does not have to re-derive which check the payout rested on, and
/// used by `GovernanceBaseline::permits_role` to ask the role-specific
/// question rather than a flat "is this declared anywhere?".
pub const DEPARTURE_OWNER: u8 = 1;
pub const DEPARTURE_FROZEN: u8 = 2;
pub const DEPARTURE_DELEGATE: u8 = 3;
pub const DEPARTURE_CLOSE_AUTHORITY: u8 = 4;
/// Declared roles with no departure branch of their own today. They exist so
/// `permits_role` is total over the declaration's fields: a caller asking
/// about an upgrade authority or a multisig controller must not fall through
/// to the wildcard arm and be told "not permitted" for a reason that is really
/// "not implemented".
pub const DEPARTURE_UPGRADE_AUTHORITY: u8 = 5;
pub const DEPARTURE_CONTROLLER: u8 = 6;
