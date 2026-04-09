use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::AgentGuardError;
use crate::events::PolicyExpiredEvent;
use crate::state::{InsurancePolicy, InsuranceVault};

/// Mark an expired policy as Expired.
/// Permissionless crank — anyone can call this.
pub fn expire_policy_handler(ctx: Context<ExpirePolicy>) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Must be active
    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE,
        AgentGuardError::PolicyNotActive
    );

    // Must be past expiry
    require!(now >= policy.expiry_time, AgentGuardError::PolicyNotExpired);

    // Update vault coverage
    vault.total_coverage = vault
        .total_coverage
        .checked_sub(policy.coverage_amount)
        .ok_or(AgentGuardError::MathOverflow)?;
    vault.recalculate_solvency();

    // Mark as expired
    policy.state = InsurancePolicy::STATE_EXPIRED;

    emit!(PolicyExpiredEvent {
        policy_id: policy.policy_id,
        holder: policy.holder,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExpirePolicy<'info> {
    /// Anyone can crank expired policies
    pub cranker: Signer<'info>,

    /// The policy to expire (validated via PDA seeds)
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.holder.as_ref(), &policy.policy_id.to_le_bytes()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, InsurancePolicy>,

    /// Insurance vault (to update coverage)
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, InsuranceVault>,
}
