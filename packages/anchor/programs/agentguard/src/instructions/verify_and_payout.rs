use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::AgentGuardError;
use crate::events::ClaimPaid;
use crate::state::{InsurancePolicy, InsuranceVault, ProtocolConfig};

/// Verify a pending claim and execute payout.
/// Only the oracle authority can call this instruction.
pub fn handler(ctx: Context<VerifyAndPayout>, payout_amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let policy = &mut ctx.accounts.policy;
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Only oracle authority
    require!(
        ctx.accounts.oracle.key() == config.oracle_authority,
        AgentGuardError::UnauthorizedOracle
    );

    // Policy must be ClaimPending
    require!(
        policy.state == InsurancePolicy::STATE_CLAIM_PENDING,
        AgentGuardError::PolicyNotClaimPending
    );

    // Payout must not exceed coverage
    require!(
        payout_amount <= policy.coverage_amount,
        AgentGuardError::PayoutExceedsCoverage
    );

    // Check lock period for the trigger type
    let lock_period = match policy.trigger_type {
        TRIGGER_EXPLOIT => LOCK_EXPLOIT,
        TRIGGER_ORACLE_MANIPULATION => LOCK_ORACLE_MANIPULATION,
        TRIGGER_AGENT_ERROR => LOCK_AGENT_ERROR,
        TRIGGER_GOVERNANCE_ATTACK => LOCK_GOVERNANCE_ATTACK,
        _ => return Err(AgentGuardError::InvalidTriggerType.into()),
    };

    let lock_expires_at = policy
        .claim_submitted_at
        .checked_add(lock_period)
        .ok_or(AgentGuardError::MathOverflow)?;
    require!(now >= lock_expires_at, AgentGuardError::LockPeriodNotElapsed);

    // Check vault has enough balance
    require!(
        ctx.accounts.vault_token_account.amount >= payout_amount,
        AgentGuardError::InsufficientVaultBalance
    );

    // Transfer payout from vault to holder
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
    token::transfer(transfer_ctx, payout_amount)?;

    // Update vault
    vault.total_claims_paid = vault
        .total_claims_paid
        .checked_add(payout_amount)
        .ok_or(AgentGuardError::MathOverflow)?;
    vault.total_staked = vault
        .total_staked
        .saturating_sub(payout_amount);
    vault.total_coverage = vault
        .total_coverage
        .checked_sub(policy.coverage_amount)
        .ok_or(AgentGuardError::MathOverflow)?;
    vault.recalculate_solvency();

    // Update policy
    policy.state = InsurancePolicy::STATE_CLAIM_PAID;
    policy.payout_amount = payout_amount;

    emit!(ClaimPaid {
        policy_id: policy.policy_id,
        holder: policy.holder,
        payout_amount,
        trigger_type: policy.trigger_type,
        paid_at: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct VerifyAndPayout<'info> {
    /// Oracle authority (signer)
    #[account(mut)]
    pub oracle: Signer<'info>,

    /// Protocol config (to verify oracle authority)
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ AgentGuardError::UnauthorizedOracle,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// The policy with a pending claim
    #[account(mut)]
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

    /// Holder USDC token account (payout destination)
    #[account(mut)]
    pub holder_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
