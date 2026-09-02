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

    /// The envelope this attestation's premium was quoted for.
    ///
    /// `AgentMandate::commitment()`. Zero means the oracle quoted no envelope,
    /// which `create_policy` refuses: the deductible is the largest single
    /// lever on what the vault can be made to pay, and a premium set without
    /// it prices nothing.
    ///
    /// This closes the same hole the `tier` field closed, one level down. The
    /// tier stopped a buyer picking LOW for a known-HIGH agent. It did not
    /// stop them buying at any tier and *then* authoring a deductible narrow
    /// enough to guarantee a breach — declaring a 100 USDC cap for an agent
    /// holding 5,000, moving 600 to an address the verifier cannot know they
    /// control, and collecting the 500 overshoot for the price of a premium
    /// quoted before any of that was decided.
    pub mandate_hash: [u8; 32],

    /// What that envelope costs, in basis points on top of the tier premium.
    ///
    /// Priced off chain, where the agent's own outflow history lives: a cap
    /// far above what the agent normally moves is a deductible the holder will
    /// rarely reach, and a cap below it is one they will breach on ordinary
    /// business. The chain cannot see that history; the oracle can, and it
    /// signs for the number.
    pub envelope_surcharge_bps: u16,

    /// PDA bump
    pub bump: u8,
}
