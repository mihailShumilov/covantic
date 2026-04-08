use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::AgentGuardError;
use crate::events::PolicyCancelled;
use crate::state::{InsurancePolicy, InsuranceVault};

/// Cancel an active policy with partial refund (20% penalty).
pub fn handler(ctx: Context<CancelPolicy>) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Must be active
    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE,
        AgentGuardError::PolicyNotActive
    );

    // Must not be expired
    require!(now < policy.expiry_time, AgentGuardError::PolicyExpired);

    // Must be the holder
    require!(
        policy.holder == ctx.accounts.holder.key(),
        AgentGuardError::UnauthorizedHolder
    );

    // Calculate refund: remaining_fraction * premium * 80%
    let elapsed = now
        .checked_sub(policy.start_time)
        .ok_or(AgentGuardError::MathOverflow)?;
    let total_duration = policy
        .expiry_time
        .checked_sub(policy.start_time)
        .ok_or(AgentGuardError::MathOverflow)?;

    let remaining_fraction_num = (total_duration
        .checked_sub(elapsed)
        .ok_or(AgentGuardError::MathOverflow)?) as u128;
    let remaining_fraction_den = total_duration as u128;

    // refund = premium * remaining / total * (10000 - penalty) / 10000
    let refund = (policy.premium_paid as u128)
        .checked_mul(remaining_fraction_num)
        .ok_or(AgentGuardError::MathOverflow)?
        .checked_div(remaining_fraction_den)
        .ok_or(AgentGuardError::MathOverflow)?
        .checked_mul((10000 - CANCEL_PENALTY_BPS) as u128)
        .ok_or(AgentGuardError::MathOverflow)?
        .checked_div(10000)
        .ok_or(AgentGuardError::MathOverflow)? as u64;

    // Transfer refund from vault to holder via PDA signature
    if refund > 0 {
        let vault_bump = vault.bump;
        let seeds = &[VAULT_SEED, &[vault_bump]];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.holder_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, refund)?;
    }

    // Update vault: remove coverage
    vault.total_coverage = vault
        .total_coverage
        .checked_sub(policy.coverage_amount)
        .ok_or(AgentGuardError::MathOverflow)?;
    vault.recalculate_solvency();

    // Update policy state
    policy.state = InsurancePolicy::STATE_CANCELLED;

    emit!(PolicyCancelled {
        policy_id: policy.policy_id,
        holder: policy.holder,
        refund_amount: refund,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelPolicy<'info> {
    /// Policy holder
    #[account(mut)]
    pub holder: Signer<'info>,

    /// The policy to cancel
    #[account(
        mut,
        constraint = policy.holder == holder.key() @ AgentGuardError::UnauthorizedHolder,
        seeds = [POLICY_SEED, holder.key().as_ref(), &policy.policy_id.to_le_bytes()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, InsurancePolicy>,

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

    /// Holder USDC token account
    #[account(mut)]
    pub holder_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
