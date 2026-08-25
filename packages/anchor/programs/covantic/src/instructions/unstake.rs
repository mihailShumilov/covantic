use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::{UnstakeRequested, Unstaked};
use crate::instructions::stake::{crystallize_rewards, settle_losses};
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

    // Pull in any rewards accrued since the staker's last interaction.
    // Losses first: revalue the position against anything socialised since it
    // was last touched, so rewards and any transfer below are computed on
    // principal that still exists.
    settle_losses(staker_position, vault)?;
    crystallize_rewards(staker_position, vault)?;

    let requested = staker_position.amount_staked;
    let rewards = staker_position.rewards_pending;

    // ---- solvency floor on the way out ------------------------------------
    //
    // `create_policy` refuses to write any new coverage below
    // `SOLVENCY_CRITICAL`. Exit now honours the same line: staked capital
    // cannot leave the vault past the point at which the protocol has already
    // decided it may not take on more risk. Without this, the ladder was
    // enforced on one side only — issuance was gated on solvency while the
    // capital backing policies already sold could withdraw to zero, leaving
    // holders with live cover and nothing behind it.
    //
    // The threshold matches `create_policy` deliberately. At the floor no new
    // coverage can be written *and* no more capital can leave, so the ratio
    // can only recover as policies expire. That bounds how long a staker can
    // be held by `MAX_POLICY_DURATION` instead of leaving it open-ended — a
    // higher floor here would not, because LOW and MEDIUM policies keep being
    // written between `SOLVENCY_CRITICAL` and `SOLVENCY_CAUTION`.
    let reserve_required = if vault.total_coverage > 0 {
        // Rounded up: the floor is a minimum, and rounding down would let the
        // last unit of stake leave the vault a hair beneath it.
        (vault.total_coverage as u128)
            .checked_mul(SOLVENCY_CRITICAL as u128)
            .ok_or(CovanticError::MathOverflow)?
            .div_ceil(10_000)
    } else {
        0
    };

    // Pay out what the floor leaves rather than refusing outright. An
    // all-or-nothing gate would make being first to exit worth more, which is
    // the run this is meant to damp; taking a share of what is free removes
    // the cliff without letting the vault fall through the floor.
    let free_capital = (vault.total_staked as u128).saturating_sub(reserve_required);
    let amount = u64::try_from(free_capital.min(requested as u128))
        .map_err(|_| error!(CovanticError::MathOverflow))?;
    require!(amount > 0, CovanticError::SolvencyTooLow);

    let remaining = requested
        .checked_sub(amount)
        .ok_or(CovanticError::MathOverflow)?;

    let total_transfer = amount
        .checked_add(rewards)
        .ok_or(CovanticError::MathOverflow)?;

    // Debit the staker-reward ledger before the CPI; underflow fails the
    // tx rather than silently allowing over-payment.
    if rewards > 0 {
        vault.total_staker_rewards = vault
            .total_staker_rewards
            .checked_sub(rewards)
            .ok_or(CovanticError::InsufficientVaultBalance)?;
    }

    // Transfer USDC + rewards from vault to staker
    let vault_bump = vault.bump;
    let seeds = &[VAULT_SEED, &[vault_bump]];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.staker_token_account.to_account_info(),
            authority: vault_info.clone(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, total_transfer)?;

    // Update vault: explicit checked_sub so an inconsistency fails the tx
    // rather than silently clamping solvency to 0.
    vault.total_staked = vault
        .total_staked
        .checked_sub(amount)
        .ok_or(CovanticError::InsufficientVaultBalance)?;
    // Only a staker who left entirely stops being a staker.
    if remaining == 0 {
        vault.staker_count = vault
            .staker_count
            .checked_sub(1)
            .ok_or(CovanticError::MathOverflow)?;
    }
    vault.recalculate_solvency();

    staker_position.amount_staked = remaining;
    staker_position.rewards_claimed = staker_position
        .rewards_claimed
        .checked_add(rewards)
        .ok_or(CovanticError::MathOverflow)?;
    staker_position.rewards_pending = 0;

    if remaining == 0 {
        staker_position.share_bps = 0;
        staker_position.unstake_requested_at = 0;
    } else {
        // The request stays open. The staker served the cooldown already, and
        // what stopped them was the protocol's own floor, not anything they
        // did — so they may draw the rest as coverage expires without waiting
        // another 48 hours.
        staker_position.share_bps = if vault.total_staked > 0 {
            u16::try_from(
                (remaining as u128)
                    .checked_mul(10000)
                    .ok_or(CovanticError::MathOverflow)?
                    .checked_div(vault.total_staked as u128)
                    .ok_or(CovanticError::MathOverflow)?
                    .min(u16::MAX as u128),
            )
            .map_err(|_| error!(CovanticError::MathOverflow))?
        } else {
            0
        };
    }

    emit!(Unstaked {
        staker: ctx.accounts.staker.key(),
        amount,
        rewards,
        remaining,
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
