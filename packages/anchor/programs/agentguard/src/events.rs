use anchor_lang::prelude::*;

/// Event: new policy created
#[event]
pub struct PolicyCreated {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub agent_address: Pubkey,
    pub coverage_amount: u64,
    pub premium_paid: u64,
    pub risk_tier: u8,
    pub start_time: i64,
    pub expiry_time: i64,
}

/// Event: claim submitted
#[event]
pub struct ClaimSubmitted {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub trigger_type: u8,
    pub submitted_at: i64,
}

/// Event: claim verified and paid out
#[event]
pub struct ClaimPaid {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub payout_amount: u64,
    pub trigger_type: u8,
    pub paid_at: i64,
}

/// Event: policy cancelled
#[event]
pub struct PolicyCancelled {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub refund_amount: u64,
}

/// Event: policy expired
#[event]
pub struct PolicyExpiredEvent {
    pub policy_id: u64,
    pub holder: Pubkey,
}

/// Event: USDC staked to the pool
#[event]
pub struct Staked {
    pub staker: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

/// Event: unstake requested
#[event]
pub struct UnstakeRequested {
    pub staker: Pubkey,
    pub amount: u64,
    pub available_at: i64,
}

/// Event: unstake executed
#[event]
pub struct Unstaked {
    pub staker: Pubkey,
    pub amount: u64,
    pub rewards: u64,
}

/// Event: staker rewards claimed
#[event]
pub struct RewardsClaimed {
    pub staker: Pubkey,
    pub amount: u64,
}
