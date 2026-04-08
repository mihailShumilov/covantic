use anchor_lang::prelude::*;

/// AI agent insurance policy.
/// PDA: seeds = [b"policy", holder.key().as_ref(), &policy_id.to_le_bytes()]
#[account]
#[derive(InitSpace)]
pub struct InsurancePolicy {
    /// Unique policy ID (from policy_counter)
    pub policy_id: u64,

    /// Policy holder wallet (paid the premium)
    pub holder: Pubkey,

    /// Agent address covered by this policy
    pub agent_address: Pubkey,

    /// Maximum coverage amount in USDC (6 decimals)
    pub coverage_amount: u64,

    /// Premium paid in USDC
    pub premium_paid: u64,

    /// Risk tier: 0=LOW, 1=MEDIUM, 2=HIGH
    pub risk_tier: u8,

    /// Unix timestamp when coverage started
    pub start_time: i64,

    /// Unix timestamp when coverage expires
    pub expiry_time: i64,

    /// Unix timestamp of claim submission (0 if not submitted)
    pub claim_submitted_at: i64,

    /// Current policy state
    /// 0 = Active, 1 = ClaimPending, 2 = ClaimApproved,
    /// 3 = ClaimPaid, 4 = Expired, 5 = Cancelled
    pub state: u8,

    /// Insurance trigger type
    /// 0=None, 1=Exploit, 2=OracleManip, 3=AgentError, 4=GovernanceAttack
    pub trigger_type: u8,

    /// Trigger transaction signature (64 bytes)
    #[max_len(64)]
    pub trigger_tx_signature: Vec<u8>,

    /// Actual payout amount (<= coverage_amount)
    pub payout_amount: u64,

    /// PDA bump
    pub bump: u8,
}

impl InsurancePolicy {
    pub const STATE_ACTIVE: u8 = 0;
    pub const STATE_CLAIM_PENDING: u8 = 1;
    pub const STATE_CLAIM_APPROVED: u8 = 2;
    pub const STATE_CLAIM_PAID: u8 = 3;
    pub const STATE_EXPIRED: u8 = 4;
    pub const STATE_CANCELLED: u8 = 5;
}
