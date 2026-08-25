use anchor_lang::prelude::*;

use crate::errors::CovanticError;

/// Scale factor for the reward-per-stake accumulator.
/// Premiums are distributed via a global accumulator:
///   reward_per_stake_acc += delta * SCALE / total_staked
/// Each staker's owed rewards are derived from the diff against their
/// stored snapshot, preventing double-claim after premium arrivals.
pub const REWARD_PER_STAKE_SCALE: u128 = 1_000_000_000_000; // 1e12

/// Scale factor for the loss index.
///
/// Losses are socialised the mirror image of the way rewards are distributed,
/// with one difference that decides the shape: rewards are **additive** per
/// unit of stake, losses are **multiplicative**. An additive loss accumulator
/// charges each position against its stale nominal principal, so a second loss
/// over-charges everyone and the positions stop summing to `total_staked`. A
/// multiplicative index does not: `loss_index` scales down by the same factor
/// the pool did, every position is worth `amount_staked * now / snapshot`, and
/// a staker who joins after a loss snapshots the current index and is
/// untouched by it.
pub const LOSS_INDEX_SCALE: u128 = 1_000_000_000_000; // 1e12

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

    /// Multiplicative index tracking cumulative socialised loss, scaled by
    /// `LOSS_INDEX_SCALE`. Starts at `LOSS_INDEX_SCALE` and only ever falls.
    /// Each staker's snapshot lives in `StakerPosition.loss_index_snapshot`;
    /// a position's live principal is
    /// `amount_staked * loss_index / loss_index_snapshot`.
    ///
    /// **Last field on purpose.** Appending keeps every byte before it at the
    /// same offset, so an account written by the previous layout still parses
    /// once grown, and migration is a resize plus one default rather than a
    /// rewrite.
    pub loss_index: u128,
}

impl InsuranceVault {
    pub const CURRENT_VERSION: u8 = 1;

    /// Absorb a payout across the loss waterfall: protocol treasury first,
    /// then the reserve fund, then staker principal.
    ///
    /// This lived inline in all five `verify_and_payout*` instructions as five
    /// copies of the same arithmetic. It is a method now because the staker
    /// leg has to move `loss_index` in step with `total_staked`, and five
    /// copies is five chances to decrement one without the other — which is
    /// exactly the bug this replaces: `total_staked` fell, no `StakerPosition`
    /// did, and the first staker out was paid in full while the last absorbed
    /// everything.
    ///
    /// Returns the amount that came out of staker principal.
    pub fn absorb_loss(&mut self, payout_amount: u64) -> Result<u64> {
        let mut remaining = payout_amount;

        let from_treasury = remaining.min(self.protocol_treasury);
        self.protocol_treasury = self
            .protocol_treasury
            .checked_sub(from_treasury)
            .ok_or(CovanticError::MathOverflow)?;
        remaining = remaining
            .checked_sub(from_treasury)
            .ok_or(CovanticError::MathOverflow)?;

        let from_reserve = remaining.min(self.reserve_fund);
        self.reserve_fund = self
            .reserve_fund
            .checked_sub(from_reserve)
            .ok_or(CovanticError::MathOverflow)?;
        remaining = remaining
            .checked_sub(from_reserve)
            .ok_or(CovanticError::MathOverflow)?;

        if remaining > 0 {
            // `total_staker_rewards` is a sub-accounting of the vault token
            // balance tracking *claimable* rewards. Do NOT reduce it here as
            // well — staker principal absorbs the loss, not the already
            // earned reward ledger.
            let before = self.total_staked;
            let after = before
                .checked_sub(remaining)
                .ok_or(CovanticError::InsufficientVaultBalance)?;

            // Scale the index by exactly the factor the pool shrank by, before
            // committing the new total. Every position then revalues itself
            // the next time it is touched, with no iteration over stakers.
            if before > 0 {
                self.loss_index = self
                    .loss_index
                    .checked_mul(after as u128)
                    .ok_or(CovanticError::MathOverflow)?
                    .checked_div(before as u128)
                    .ok_or(CovanticError::MathOverflow)?;
            }
            self.total_staked = after;
        }

        Ok(remaining)
    }

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

