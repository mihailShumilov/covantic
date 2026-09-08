use anchor_lang::prelude::*;

/// Global protocol configuration.
/// PDA: seeds = [CONFIG_SEED], where `CONFIG_SEED` is `b"covantic_config"` (see `constants.rs`).
/// Created ONCE during initialization.
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    /// Protocol administrator (can modify parameters)
    pub admin: Pubkey,

    /// Oracle authority — the only signer allowed to file claims on behalf of
    /// holders and to call the proof-verifying payout instructions
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
