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

    /// What that envelope costs, as a flat amount in the covered mint's base
    /// units. Added to the tier premium, and **not** scaled by duration.
    ///
    /// A rate was the wrong shape and the arithmetic said so. The envelope's
    /// cost is the amount a holder can extract at will — move more than the
    /// declared cap to an address the verifier cannot attribute to them, and
    /// collect the overshoot — and that ability exists from the first minute of
    /// the policy, not pro rata over its life. Charged as an annual rate it
    /// dissolved into the tenor: a one-hour policy cost 0.23 USDC for an
    /// ability worth up to the full coverage, and no duration this program
    /// allows was long enough to close it. Break-even was 356 days against a
    /// 30-day maximum.
    ///
    /// Flat, the tenor stops being a lever. It is bounded by the coverage
    /// because that is what bounds the extractable amount, and because an
    /// unbounded figure would let a compromised oracle key refuse coverage by
    /// arithmetic rather than by declining to attest.
    pub envelope_flat_premium: u64,

    /// PDA bump
    pub bump: u8,
}
