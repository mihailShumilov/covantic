use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::ClaimSubmitted;
use crate::state::{InsurancePolicy, ProtocolConfig};

/// Submit an insurance claim on behalf of a policy holder.
///
/// Only the configured oracle authority can call this. The oracle's job is to
/// move a policy from Active -> ClaimPending whenever its off-chain monitors
/// (Helius webhooks, Pyth feeds) detect a trigger event. The actual payout
/// still goes through the existing `verify_and_payout` instruction, so the
/// oracle never has unilateral access to vault funds without the state
/// transition being persisted on-chain first.
///
/// Coexists with holder-signed `submit_claim` — the holder path is preserved
/// so an agent (via SDK) can still file its own claim.
pub fn oracle_submit_claim_handler(
    ctx: Context<OracleSubmitClaim>,
    trigger_type: u8,
    trigger_tx_signature: Vec<u8>,
) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE,
        CovanticError::PolicyNotActive
    );

    require!(now < policy.expiry_time, CovanticError::PolicyExpired);

    require!(
        trigger_type >= TRIGGER_EXPLOIT && trigger_type <= TRIGGER_GOVERNANCE_ATTACK,
        CovanticError::InvalidTriggerType
    );

    require!(!trigger_tx_signature.is_empty(), CovanticError::TriggerTxRequired);

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
pub struct OracleSubmitClaim<'info> {
    /// Oracle authority — must match `config.oracle_authority`.
    pub oracle: Signer<'info>,

    /// Protocol config (provides the oracle authority to check against).
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ CovanticError::UnauthorizedOracle,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// The policy being filed against. Seeds use the stored holder pubkey so
    /// the oracle does not need the holder keypair and cannot spoof the PDA.
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.holder.as_ref(), &policy.policy_id.to_le_bytes()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, InsurancePolicy>,
}
