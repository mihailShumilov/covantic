use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::AgentGuardError;
use crate::events::RewardsClaimed;
use crate::state::{InsuranceVault, StakerPosition};

/// Claim accumulated staker rewards.
pub fn handler(ctx: Context<ClaimRewards>) -> Result<()> {
    let staker_position = &mut ctx.accounts.staker_position;
    let vault = &mut ctx.accounts.vault;

    // Calculate pending rewards based on share_bps and total_staker_rewards
    // Rewards are proportional to pool share
    if vault.total_staked > 0 {
        let share = (vault.total_staker_rewards as u128)
            .checked_mul(staker_position.amount_staked as u128)
            .ok_or(AgentGuardError::MathOverflow)?
            .checked_div(vault.total_staked as u128)
            .ok_or(AgentGuardError::MathOverflow)? as u64;

        let already_claimed = staker_position.rewards_claimed;
        let total_earned = share;
        if total_earned > already_claimed {
            staker_position.rewards_pending = total_earned
                .checked_sub(already_claimed)
                .ok_or(AgentGuardError::MathOverflow)?;
        }
    }

    let rewards = staker_position.rewards_pending;
    require!(rewards > 0, AgentGuardError::NoRewardsToClaim);

    // Transfer rewards from vault to staker
    let vault_bump = vault.bump;
    let seeds = &[VAULT_SEED, &[vault_bump]];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.staker_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, rewards)?;

    // Update staker position
    staker_position.rewards_claimed = staker_position
        .rewards_claimed
        .checked_add(rewards)
        .ok_or(AgentGuardError::MathOverflow)?;
    staker_position.rewards_pending = 0;

    emit!(RewardsClaimed {
        staker: ctx.accounts.staker.key(),
        amount: rewards,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
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

    /// Vault USDC token account
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Staker USDC token account
    #[account(mut)]
    pub staker_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
