use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::state::ProtocolConfig;

/// Admin-only instruction to rotate the oracle authority, the pause state and
/// the premium multiplier.
///
/// Each field is optional: pass None to leave the current value untouched.
///
/// Admin handover is **not** here. This doc comment used to claim the new
/// admin had to counter-sign, which the code never required — it assigned
/// `config.admin` outright. That gap is now closed the way the comment always
/// described: `propose_admin` records a candidate and `accept_admin` requires
/// that candidate's signature.
pub fn update_config_handler(
    ctx: Context<UpdateConfig>,
    new_oracle_authority: Option<Pubkey>,
    new_paused: Option<bool>,
    new_premium_multiplier_bps: Option<u16>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    require!(
        ctx.accounts.admin.key() == config.admin,
        CovanticError::UnauthorizedAdmin
    );

    // Admin handover deliberately does NOT live here. It is a two-step
    // propose/accept via `propose_admin` + `accept_admin`, so a mistyped key
    // cannot take the one role that can pause the protocol and rotate the
    // oracle authority. Do not reintroduce a `new_admin` parameter.

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
