use anchor_lang::prelude::*;

/// Scale factor for the reward-per-stake accumulator.
/// Premiums are distributed via a global accumulator:
///   reward_per_stake_acc += delta * SCALE / total_staked
/// Each staker's owed rewards are derived from the diff against their
/// stored snapshot, preventing double-claim after premium arrivals.
pub const REWARD_PER_STAKE_SCALE: u128 = 1_000_000_000_000; // 1e12

/// Insurance pool vault.
/// PDA: seeds = [b"vault"]
/// ONE per protocol.
#[account]
#[derive(InitSpace)]
pub struct InsuranceVault {
    /// Schema version for forward-compatible deserialization
    pub version: u8,

    /// Authority PDA for signing CPI (transfers from vault)
    pub authority: Pubkey,

    /// Total USDC staked
    pub total_staked: u64,

    /// Sum of all active coverages
    pub total_coverage: u64,

    /// All premiums collected (lifetime)
    pub total_premiums_collected: u64,

    /// All claims paid (lifetime)
    pub total_claims_paid: u64,

    /// Number of stakers
    pub staker_count: u32,

    /// Solvency ratio in basis points:
    /// (total_staked * 10000) / total_coverage
    /// 0 if total_coverage == 0
    pub solvency_ratio: u16,

    /// Remaining claimable staker rewards (premium share not yet paid out).
    /// Incremented on `create_policy` (staker share of premium) and
    /// decremented when stakers claim via `claim_rewards` or `execute_unstake`.
    pub total_staker_rewards: u64,

    /// Global accumulator for rewards-per-stake, scaled by REWARD_PER_STAKE_SCALE.
    /// New premiums update this by `delta * SCALE / total_staked`; each
    /// staker's snapshot lives in StakerPosition.reward_per_stake_snapshot.
    pub reward_per_stake_acc: u128,

    /// Reserve fund (20% of premiums)
    pub reserve_fund: u64,

    /// Protocol treasury (10% of premiums)
    pub protocol_treasury: u64,

    /// PDA bump
    pub bump: u8,
}

impl InsuranceVault {
    pub const CURRENT_VERSION: u8 = 1;

    /// Recalculate solvency ratio after any state change
    pub fn recalculate_solvency(&mut self) {
        if self.total_coverage == 0 {
            self.solvency_ratio = u16::MAX;
        } else {
            let ratio = (self.total_staked as u128)
                .checked_mul(10000)
                .unwrap_or(0)
                .checked_div(self.total_coverage as u128)
                .unwrap_or(0);
            self.solvency_ratio = ratio.min(u16::MAX as u128) as u16;
        }
    }

    /// Record a new staker-share premium. Updates both the running
    /// total and the reward-per-stake accumulator so that pre-existing
    /// stakers earn proportionally without double-claim risk.
    /// No-op if there is currently no stake.
    pub fn accrue_staker_rewards(&mut self, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        self.total_staker_rewards = self
            .total_staker_rewards
            .checked_add(amount)
            .ok_or(crate::errors::CovanticError::MathOverflow)?;
        if self.total_staked > 0 {
            let delta = (amount as u128)
                .checked_mul(REWARD_PER_STAKE_SCALE)
                .ok_or(crate::errors::CovanticError::MathOverflow)?
                .checked_div(self.total_staked as u128)
                .ok_or(crate::errors::CovanticError::MathOverflow)?;
            self.reward_per_stake_acc = self
                .reward_per_stake_acc
                .checked_add(delta)
                .ok_or(crate::errors::CovanticError::MathOverflow)?;
        }
        Ok(())
    }
}

