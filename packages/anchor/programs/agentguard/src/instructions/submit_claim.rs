use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::AgentGuardError;
use crate::events::ClaimSubmitted;
use crate::state::InsurancePolicy;

/// Submit an insurance claim for an active policy.
/// Only the policy holder can submit.
pub fn handler(
    ctx: Context<SubmitClaim>,
    trigger_type: u8,
    trigger_tx_signature: Vec<u8>,
) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Must be active
    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE,
        AgentGuardError::PolicyNotActive
    );

    // Must not be expired
    require!(now < policy.expiry_time, AgentGuardError::PolicyExpired);

    // Validate trigger type (1-4)
    require!(
        trigger_type >= TRIGGER_EXPLOIT && trigger_type <= TRIGGER_GOVERNANCE_ATTACK,
        AgentGuardError::InvalidTriggerType
    );

    // Trigger tx signature is required
    require!(!trigger_tx_signature.is_empty(), AgentGuardError::TriggerTxRequired);

    // Update policy
    policy.state = InsurancePolicy::STATE_CLAIM_PENDING;
    policy.trigger_type = trigger_type;
    policy.trigger_tx_signature = trigger_tx_signature;
    policy.claim_submitted_at = now;

    emit!(ClaimSubmitted {
        policy_id: policy.policy_id,
        holder: policy.holder,
        trigger_type,
        submitted_at: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SubmitClaim<'info> {
    /// Policy holder
    pub holder: Signer<'info>,

    /// The policy to submit a claim for
    #[account(
        mut,
        constraint = policy.holder == holder.key() @ AgentGuardError::UnauthorizedHolder,
        seeds = [POLICY_SEED, holder.key().as_ref(), &policy.policy_id.to_le_bytes()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, InsurancePolicy>,
}
