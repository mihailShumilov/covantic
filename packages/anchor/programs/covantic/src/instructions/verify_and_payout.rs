use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::ClaimPaid;
use crate::state::{InsurancePolicy, InsuranceVault, ProtocolConfig};

/// Verify a pending claim and execute payout.
/// Only the oracle authority can call this instruction.
pub fn verify_and_payout_handler(ctx: Context<VerifyAndPayout>, payout_amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let policy = &mut ctx.accounts.policy;
    let vault_info = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Only oracle authority
    require!(
        ctx.accounts.oracle.key() == config.oracle_authority,
        CovanticError::UnauthorizedOracle
    );

    // Policy must be ClaimPending
    require!(
        policy.state == InsurancePolicy::STATE_CLAIM_PENDING,
        CovanticError::PolicyNotClaimPending
    );

    // Payout must not exceed coverage
    require!(
        payout_amount <= policy.coverage_amount,
        CovanticError::PayoutExceedsCoverage
    );

    // Check lock period for the trigger type
    let lock_period = match policy.trigger_type {
        TRIGGER_EXPLOIT => LOCK_EXPLOIT,
        TRIGGER_ORACLE_MANIPULATION => LOCK_ORACLE_MANIPULATION,
        TRIGGER_AGENT_ERROR => LOCK_AGENT_ERROR,
        TRIGGER_GOVERNANCE_ATTACK => LOCK_GOVERNANCE_ATTACK,
        _ => return Err(CovanticError::InvalidTriggerType.into()),
    };

    let lock_expires_at = policy
        .claim_submitted_at
        .checked_add(lock_period)
        .ok_or(CovanticError::MathOverflow)?;
    require!(now >= lock_expires_at, CovanticError::LockPeriodNotElapsed);

    // Check vault has enough balance
    require!(
        ctx.accounts.vault_token_account.amount >= payout_amount,
        CovanticError::InsufficientVaultBalance
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
            authority: vault_info.clone(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, payout_amount)?;

    // Update total claims
    vault.total_claims_paid = vault
        .total_claims_paid
        .checked_add(payout_amount)
        .ok_or(CovanticError::MathOverflow)?;

    // Loss cascade: protocol_treasury -> reserve_fund -> total_staked.
    // Use checked_sub on total_staked so an oversized loss fails the tx
    // explicitly (InsufficientVaultBalance is the closest matching error)
    // instead of silently clamping solvency to 0.
    let mut remaining = payout_amount;

    let from_treasury = remaining.min(vault.protocol_treasury);
    vault.protocol_treasury = vault
        .protocol_treasury
        .checked_sub(from_treasury)
        .ok_or(CovanticError::MathOverflow)?;
    remaining = remaining
        .checked_sub(from_treasury)
        .ok_or(CovanticError::MathOverflow)?;

    let from_reserve = remaining.min(vault.reserve_fund);
    vault.reserve_fund = vault
        .reserve_fund
        .checked_sub(from_reserve)
        .ok_or(CovanticError::MathOverflow)?;
    remaining = remaining
        .checked_sub(from_reserve)
        .ok_or(CovanticError::MathOverflow)?;

    if remaining > 0 {
        // total_staker_rewards is a sub-accounting of the vault token balance
        // that tracks *claimable* rewards for stakers. Do NOT reduce it here
        // as well -- the staker principal absorbs the loss, not the already
        // earned/pending reward ledger.
        vault.total_staked = vault
            .total_staked
            .checked_sub(remaining)
            .ok_or(CovanticError::InsufficientVaultBalance)?;
    }

    vault.total_coverage = vault
        .total_coverage
        .checked_sub(policy.coverage_amount)
        .ok_or(CovanticError::MathOverflow)?;
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
        constraint = config.oracle_authority == oracle.key() @ CovanticError::UnauthorizedOracle,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// The policy with a pending claim (validated via PDA seeds)
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.holder.as_ref(), &policy.policy_id.to_le_bytes()],
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

    /// Vault USDC token account (must belong to vault and be USDC mint)
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ CovanticError::InvalidTokenAccount,
        constraint = vault_token_account.mint == config.usdc_mint @ CovanticError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Holder USDC token account (must belong to policy holder and be USDC mint)
    #[account(
        mut,
        constraint = holder_token_account.owner == policy.holder @ CovanticError::InvalidTokenAccount,
        constraint = holder_token_account.mint == config.usdc_mint @ CovanticError::InvalidTokenAccount,
    )]
    pub holder_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
