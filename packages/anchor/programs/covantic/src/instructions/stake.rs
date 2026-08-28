use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{CONFIG_SEED, STAKER_SEED, VAULT_SEED};
use crate::errors::CovanticError;
use crate::events::Staked;
use crate::state::insurance_vault::REWARD_PER_STAKE_SCALE;
use crate::state::{InsuranceVault, ProtocolConfig, StakerPosition};

/// Compute the pending reward delta for a staker based on the global
/// reward-per-stake accumulator. Returns 0 when the staker has no
/// position or the accumulator has not advanced past the snapshot.
pub fn pending_reward_delta(
    position: &StakerPosition,
    vault: &InsuranceVault,
) -> Result<u64> {
    if position.amount_staked == 0 {
        return Ok(0);
    }
    let acc_delta = vault
        .reward_per_stake_acc
        .checked_sub(position.reward_per_stake_snapshot)
        .ok_or(CovanticError::MathOverflow)?;
    if acc_delta == 0 {
        return Ok(0);
    }
    let earned = acc_delta
        .checked_mul(position.amount_staked as u128)
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(REWARD_PER_STAKE_SCALE)
        .ok_or(CovanticError::MathOverflow)?;
    // Narrowing here was unbounded. A reward that does not fit u64 means the
    // accumulator is already wrong; truncating would pay a silently wrong
    // number, so fail the transaction instead.
    u64::try_from(earned).map_err(|_| error!(CovanticError::MathOverflow))
}

/// Revalue a position against the losses socialised since it was last touched.
///
/// Must run before `crystallize_rewards` and before any read of
/// `amount_staked` that decides a transfer. Rewards for the window are then
/// computed on the post-loss principal, which slightly under-credits a staker
/// whose loss landed late in the window. The exact split needs a checkpoint
/// per loss event; this errs toward the vault, which is the safe direction
/// when the alternative is paying rewards on principal that no longer exists.
pub fn settle_losses(position: &mut StakerPosition, vault: &InsuranceVault) -> Result<()> {
    // A position written before this accounting existed, or one that has never
    // seen a loss. Adopt the current index; there is nothing to revalue and a
    // zero divisor is not a ratio.
    if position.loss_index_snapshot == 0 || position.amount_staked == 0 {
        position.loss_index_snapshot = vault.loss_index;
        return Ok(());
    }
    if position.loss_index_snapshot == vault.loss_index {
        return Ok(());
    }

    let revalued = (position.amount_staked as u128)
        .checked_mul(vault.loss_index)
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(position.loss_index_snapshot)
        .ok_or(CovanticError::MathOverflow)?;
    position.amount_staked =
        u64::try_from(revalued).map_err(|_| error!(CovanticError::MathOverflow))?;
    position.loss_index_snapshot = vault.loss_index;
    Ok(())
}

/// Crystallize outstanding rewards for a staker into rewards_pending
/// and advance their snapshot to the current accumulator.
pub fn crystallize_rewards(
    position: &mut StakerPosition,
    vault: &InsuranceVault,
) -> Result<()> {
    let delta = pending_reward_delta(position, vault)?;
    if delta > 0 {
        position.rewards_pending = position
            .rewards_pending
            .checked_add(delta)
            .ok_or(CovanticError::MathOverflow)?;
    }
    position.reward_per_stake_snapshot = vault.reward_per_stake_acc;
    Ok(())
}

/// Stake USDC into the insurance pool.
pub fn stake_handler(ctx: Context<Stake>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let vault = &mut ctx.accounts.vault;
    let staker_position = &mut ctx.accounts.staker_position;
    let clock = Clock::get()?;

    // Protocol must not be paused
    require!(!config.paused, CovanticError::ProtocolPaused);

    // Amount must be positive
    require!(amount > 0, CovanticError::ZeroStakeAmount);

    // Transfer USDC from staker to vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.staker_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.staker.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    // Losses first, then rewards, both before amount_staked changes. A fresh
    // position has snapshot 0 and adopts the current index, so a staker who
    // joins after a loss is not charged for it; an existing one is revalued,
    // and the added stake lands on top of the post-loss principal.
    settle_losses(staker_position, vault)?;
    crystallize_rewards(staker_position, vault)?;

    // Check if this is a new staker (amount_staked == 0 and deposited_at == 0)
    let is_new_staker = staker_position.amount_staked == 0 && staker_position.deposited_at == 0;

    // Update staker position
    if staker_position.version == 0 {
        staker_position.version = StakerPosition::CURRENT_VERSION;
    }
    staker_position.staker = ctx.accounts.staker.key();
    staker_position.amount_staked = staker_position
        .amount_staked
        .checked_add(amount)
        .ok_or(CovanticError::MathOverflow)?;
    if is_new_staker {
        staker_position.deposited_at = clock.unix_timestamp;
    }
    staker_position.bump = ctx.bumps.staker_position;

    // Update vault
    vault.total_staked = vault
        .total_staked
        .checked_add(amount)
        .ok_or(CovanticError::MathOverflow)?;
    if is_new_staker {
        vault.staker_count = vault
            .staker_count
            .checked_add(1)
            .ok_or(CovanticError::MathOverflow)?;
    }
    vault.recalculate_solvency();

    // Update share_bps (lazy — informational only)
    if vault.total_staked > 0 {
        // Clamped rather than cast bare: this is only <= 10000 while
        // amount_staked <= total_staked, an invariant maintained in another
        // instruction. `InsuranceVault::recalculate_solvency` clamps the
        // sibling ratio for the same reason — keep the two in step.
        staker_position.share_bps = (staker_position.amount_staked as u128)
            .checked_mul(10000)
            .ok_or(CovanticError::MathOverflow)?
            .checked_div(vault.total_staked as u128)
            .ok_or(CovanticError::MathOverflow)?
            .min(u16::MAX as u128) as u16;
    }

    emit!(Staked {
        staker: ctx.accounts.staker.key(),
        amount,
        total_staked: vault.total_staked,
    });

    Ok(())
}


#[derive(Accounts)]
pub struct Stake<'info> {
    /// Staker (signer and payer)
    #[account(mut)]
    pub staker: Signer<'info>,

    /// Protocol config
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// Insurance vault
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, InsuranceVault>,

    /// Staker position PDA (init_if_needed for first-time stakers)
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + StakerPosition::INIT_SPACE,
        seeds = [STAKER_SEED, staker.key().as_ref()],
        bump,
    )]
    pub staker_position: Account<'info, StakerPosition>,

    /// Staker's USDC token account
    #[account(
        mut,
        constraint = staker_token_account.owner == staker.key(),
        constraint = staker_token_account.mint == config.usdc_mint,
    )]
    pub staker_token_account: Account<'info, TokenAccount>,

    /// Vault USDC token account
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key(),
        constraint = vault_token_account.mint == config.usdc_mint,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
