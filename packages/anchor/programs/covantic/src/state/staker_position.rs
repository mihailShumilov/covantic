use anchor_lang::prelude::*;

/// Staker position in the insurance pool.
/// PDA: seeds = [b"staker", staker.key().as_ref()]
/// One account per staker.
#[account]
#[derive(InitSpace)]
pub struct StakerPosition {
    /// Staker wallet
    pub staker: Pubkey,

    /// Staked amount in USDC
    pub amount_staked: u64,

    /// Pool share (basis points 0-10000)
    pub share_bps: u16,

    /// Total rewards already claimed
    pub rewards_claimed: u64,

    /// Accumulated unclaimed rewards
    pub rewards_pending: u64,

    /// Unix timestamp of deposit
    pub deposited_at: i64,

    /// Unix timestamp of unstake request (0 if not requested).
    /// Unstake only allowed 48 hours after this timestamp.
    pub unstake_requested_at: i64,

    /// PDA bump
    pub bump: u8,
}
