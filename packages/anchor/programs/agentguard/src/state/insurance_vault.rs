use anchor_lang::prelude::*;

/// Insurance pool vault.
/// PDA: seeds = [b"vault"]
/// ONE per protocol.
#[account]
#[derive(InitSpace)]
pub struct InsuranceVault {
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

    /// Total accumulated staker rewards (from premiums)
    pub total_staker_rewards: u64,

    /// Reserve fund (20% of premiums)
    pub reserve_fund: u64,

    /// Protocol treasury (10% of premiums)
    pub protocol_treasury: u64,

    /// PDA bump
    pub bump: u8,
}

impl InsuranceVault {
    /// Recalculate solvency ratio after any state change
    pub fn recalculate_solvency(&mut self) {
        if self.total_coverage == 0 {
            self.solvency_ratio = u16::MAX; // Infinite solvency when no coverage
        } else {
            let ratio = (self.total_staked as u128)
                .checked_mul(10000)
                .unwrap_or(0)
                .checked_div(self.total_coverage as u128)
                .unwrap_or(0);
            self.solvency_ratio = ratio.min(u16::MAX as u128) as u16;
        }
    }
}
