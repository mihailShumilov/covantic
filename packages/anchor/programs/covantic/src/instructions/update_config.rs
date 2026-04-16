use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::state::ProtocolConfig;

/// Admin-only instruction to rotate protocol authorities and pause state.
///
/// Each field is optional: pass None to leave the current value untouched.
/// Transferring admin requires the new admin to accept by counter-signing
/// the transaction — the new admin must be a writable signer here.
pub fn update_config_handler(
    ctx: Context<UpdateConfig>,
    new_admin: Option<Pubkey>,
    new_oracle_authority: Option<Pubkey>,
    new_paused: Option<bool>,
    new_premium_multiplier_bps: Option<u16>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        ctx.accounts.admin.key() == config.admin,
        CovanticError::UnauthorizedAdmin
    );

    if let Some(admin) = new_admin {
        config.admin = admin;
    }
    if let Some(oracle) = new_oracle_authority {
        config.oracle_authority = oracle;
    }
    if let Some(paused) = new_paused {
        config.paused = paused;
    }
    if let Some(multiplier) = new_premium_multiplier_bps {
        // Bound the multiplier so a misfire can't 100x premiums.
        require!(multiplier >= 5000 && multiplier <= 30000, CovanticError::InvalidRiskTier);
        config.premium_multiplier_bps = multiplier;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// Current admin — must match config.admin
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,
}
