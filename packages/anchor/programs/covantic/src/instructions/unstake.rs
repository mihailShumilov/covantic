use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::{UnstakeRequested, Unstaked};
use crate::state::{InsuranceVault, StakerPosition};

/// Phase 1: Request unstake — starts the 48-hour cooldown period.
pub fn request_unstake_handler(ctx: Context<RequestUnstake>) -> Result<()> {
    let staker_position = &mut ctx.accounts.staker_position;
    let clock = Clock::get()?;

    require!(
        staker_position.amount_staked > 0,
        CovanticError::ZeroStakeAmount
    );

    // Record unstake request timestamp
    staker_position.unstake_requested_at = clock.unix_timestamp;

    let available_at = clock
        .unix_timestamp
        .checked_add(UNSTAKE_COOLDOWN)
        .ok_or(CovanticError::MathOverflow)?;

    emit!(UnstakeRequested {
        staker: ctx.accounts.staker.key(),
        amount: staker_position.amount_staked,
        available_at,
    });

    Ok(())
}

/// Phase 2: Execute unstake — transfers USDC + rewards after cooldown.
pub fn execute_unstake_handler(ctx: Context<ExecuteUnstake>) -> Result<()> {
    let staker_position = &mut ctx.accounts.staker_position;
    let vault_info = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Must have a pending unstake request
    require!(
        staker_position.unstake_requested_at > 0,
        CovanticError::NoUnstakeRequest
    );

    // Must wait for cooldown
    let cooldown_end = staker_position
        .unstake_requested_at
        .checked_add(UNSTAKE_COOLDOWN)
        .ok_or(CovanticError::MathOverflow)?;
    require!(
        now >= cooldown_end,
        CovanticError::UnstakeCooldownNotElapsed
    );

    let amount = staker_position.amount_staked;
    let rewards = staker_position.rewards_pending;
    let total_transfer = amount
        .checked_add(rewards)
        .ok_or(CovanticError::MathOverflow)?;

    // Transfer USDC + rewards from vault to staker
    let vault_bump = vault.bump;
    let seeds = &[VAULT_SEED, &[vault_bump]];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.staker_token_account.to_account_info(),
            authority: vault_info.clone(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, total_transfer)?;

    // Update vault
    vault.total_staked = vault.total_staked.saturating_sub(amount);
    vault.staker_count = vault.staker_count.saturating_sub(1);
    vault.recalculate_solvency();

    // Reset staker position
    staker_position.amount_staked = 0;
    staker_position.share_bps = 0;
    staker_position.rewards_claimed = staker_position
        .rewards_claimed
        .checked_add(rewards)
        .ok_or(CovanticError::MathOverflow)?;
    staker_position.rewards_pending = 0;
    staker_position.unstake_requested_at = 0;

    emit!(Unstaked {
        staker: ctx.accounts.staker.key(),
        amount,
        rewards,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RequestUnstake<'info> {
    /// Staker
    pub staker: Signer<'info>,

    /// Staker position
    #[account(
        mut,
        seeds = [STAKER_SEED, staker.key().as_ref()],
        bump = staker_position.bump,
        constraint = staker_position.staker == staker.key(),
    )]
    pub staker_position: Account<'info, StakerPosition>,
}

#[derive(Accounts)]
pub struct ExecuteUnstake<'info> {
    /// Staker
    #[account(mut)]
    pub staker: Signer<'info>,

    /// Staker position
    #[account(
        mut,
        seeds = [STAKER_SEED, staker.key().as_ref()],
        bump = staker_position.bump,
        constraint = staker_position.staker == staker.key(),
    )]
    pub staker_position: Account<'info, StakerPosition>,

    /// Insurance vault
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, InsuranceVault>,

    /// Vault USDC token account (must belong to vault)
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ CovanticError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Staker USDC token account (must belong to staker and match mint)
    #[account(
        mut,
        constraint = staker_token_account.owner == staker.key() @ CovanticError::InvalidTokenAccount,
        constraint = staker_token_account.mint == vault_token_account.mint @ CovanticError::InvalidTokenAccount,
    )]
    pub staker_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
