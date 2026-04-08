use anchor_lang::prelude::*;

/// Global protocol configuration.
/// PDA: seeds = [b"config"]
/// Created ONCE during initialization.
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    /// Protocol administrator (can modify parameters)
    pub admin: Pubkey,

    /// Oracle authority — only account allowed to call verify_and_payout
    pub oracle_authority: Pubkey,

    /// USDC mint address
    pub usdc_mint: Pubkey,

    /// Global policy counter (auto-increment ID)
    pub policy_counter: u64,

    /// Is the protocol paused?
    pub paused: bool,

    /// Solvency-based premium multiplier (bps). Default 10000 = 1.0x
    pub premium_multiplier_bps: u16,

    /// PDA bump
    pub bump: u8,
}
