use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::AttestationUpserted;
use crate::state::{ProtocolConfig, RiskAttestation};

/// Publish or refresh a risk attestation for an agent. Only the oracle
/// authority configured in ProtocolConfig may sign this instruction, so the
/// off-chain risk engine remains the single source of truth for tiers.
///
/// The PDA is keyed on `agent`, so repeated calls for the same agent
/// overwrite in place — the oracle can refresh before expiry without
/// touching policy state.
pub fn upsert_attestation_handler(
    ctx: Context<UpsertAttestation>,
    agent: Pubkey,
    tier: u8,
    valid_for_seconds: i64,
) -> Result<()> {
    // Only insurable tiers — the oracle must not mint EXTREME attestations.
    require!(tier <= RISK_TIER_HIGH, CovanticError::InvalidRiskTier);

    require!(
        valid_for_seconds > 0 && valid_for_seconds <= MAX_ATTESTATION_VALIDITY,
        CovanticError::InvalidAttestationValidity
    );

    require!(
        ctx.accounts.oracle.key() == ctx.accounts.config.oracle_authority,
        CovanticError::UnauthorizedOracle
    );

    let now = Clock::get()?.unix_timestamp;
    let expires_at = now
        .checked_add(valid_for_seconds)
        .ok_or(CovanticError::MathOverflow)?;

    let att = &mut ctx.accounts.attestation;
    att.agent = agent;
    att.tier = tier;
    att.issued_at = now;
    att.expires_at = expires_at;
    att.bump = ctx.bumps.attestation;

    emit!(AttestationUpserted {
        agent,
        tier,
        issued_at: now,
        expires_at,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct UpsertAttestation<'info> {
    /// Oracle authority (signer + rent payer on first write).
    #[account(mut)]
    pub oracle: Signer<'info>,

    /// Protocol config — used to authorize the oracle signer.
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// Risk attestation PDA — created on first publish, overwritten after.
    #[account(
        init_if_needed,
        payer = oracle,
        space = 8 + RiskAttestation::INIT_SPACE,
        seeds = [ATTESTATION_SEED, agent.as_ref()],
        bump,
    )]
    pub attestation: Account<'info, RiskAttestation>,

    pub system_program: Program<'info, System>,
}
