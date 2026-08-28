use anchor_lang::prelude::*;

/// Staker position in the insurance pool.
/// PDA: seeds = [b"staker", staker.key().as_ref()]
/// One account per staker.
#[account]
#[derive(InitSpace)]
pub struct StakerPosition {
    /// Schema version for forward-compatible deserialization
    pub version: u8,

    /// Staker wallet
    pub staker: Pubkey,

    /// Staked amount in USDC
    pub amount_staked: u64,

    /// Pool share (basis points 0-10000) — informational only
    pub share_bps: u16,

    /// Total rewards already claimed
    pub rewards_claimed: u64,

    /// Accumulated unclaimed rewards (crystallized on stake/claim boundaries)
    pub rewards_pending: u64,

    /// Snapshot of InsuranceVault.reward_per_stake_acc at the time
    /// rewards_pending was last crystallized.
    pub reward_per_stake_snapshot: u128,

    /// Unix timestamp of deposit
    pub deposited_at: i64,

    /// Unix timestamp of unstake request (0 if not requested).
    /// Unstake only allowed 48 hours after this timestamp.
    pub unstake_requested_at: i64,

    /// PDA bump
    pub bump: u8,

    /// Snapshot of `InsuranceVault.loss_index` when this position's
    /// `amount_staked` was last revalued. The position's live principal is
    /// `amount_staked * vault.loss_index / loss_index_snapshot`.
    ///
    /// Zero means "not yet initialised" — a position written before losses
    /// were socialised at all. `settle_losses` adopts the current index in
    /// that case rather than revaluing against a divisor of zero, which is
    /// also what makes a migrated position safe with no value written.
    ///
    /// **Last field on purpose**, for the same reason as `InsuranceVault`.
    pub loss_index_snapshot: u128,
}

impl StakerPosition {
    pub const CURRENT_VERSION: u8 = 1;
}
