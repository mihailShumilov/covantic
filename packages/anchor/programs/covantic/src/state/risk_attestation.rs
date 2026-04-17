use anchor_lang::prelude::*;

/// Oracle-signed attestation of a risk tier for a specific agent.
///
/// The backend's risk engine produces a score and tier, then the oracle
/// authority signs an `UpsertAttestation` transaction that writes this
/// account. Policy creation (`create_policy`) refuses to run without a
/// live attestation, which prevents buyers from self-selecting a cheaper
/// tier than their agent's on-chain behavior earns.
///
/// PDA: `[ATTESTATION_SEED, agent.as_ref()]`.
#[account]
#[derive(InitSpace)]
pub struct RiskAttestation {
    /// Agent address this attestation covers. Must match `create_policy.agent_address`.
    pub agent: Pubkey,

    /// Risk tier (0=LOW, 1=MEDIUM, 2=HIGH). EXTREME agents never receive an
    /// attestation — the oracle refuses to sign for them, so `create_policy`
    /// has no path to approve coverage.
    pub tier: u8,

    /// Unix timestamp when this attestation was minted.
    pub issued_at: i64,

    /// Unix timestamp after which this attestation is considered stale.
    /// `create_policy` rejects anything past this point.
    pub expires_at: i64,

    /// PDA bump
    pub bump: u8,
}
