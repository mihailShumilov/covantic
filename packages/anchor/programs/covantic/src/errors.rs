use anchor_lang::prelude::*;

/// Custom error codes for the Covantic protocol.
#[error_code]
pub enum CovanticError {
    // -- Policy Errors --
    #[msg("Coverage amount below minimum (1 USDC)")]
    CoverageTooLow,

    #[msg("Coverage amount exceeds maximum (1,000,000 USDC)")]
    CoverageTooHigh,

    #[msg("Policy duration below minimum (1 hour)")]
    DurationTooShort,

    #[msg("Policy duration exceeds maximum (30 days)")]
    DurationTooLong,

    #[msg("Invalid risk tier (must be 0=LOW, 1=MEDIUM, or 2=HIGH)")]
    InvalidRiskTier,

    #[msg("Policy is not in Active state")]
    PolicyNotActive,

    #[msg("Policy has expired")]
    PolicyExpired,

    #[msg("Policy has not expired yet")]
    PolicyNotExpired,

    #[msg("Maximum policies per wallet reached (10)")]
    MaxPoliciesReached,

    #[msg("Incorrect premium amount")]
    IncorrectPremium,

    // -- Claim Errors --
    #[msg("Claim already submitted for this policy")]
    ClaimAlreadySubmitted,

    #[msg("Invalid trigger type")]
    InvalidTriggerType,

    #[msg("Trigger transaction signature is required")]
    TriggerTxRequired,

    #[msg("Trigger transaction signature length exceeds the on-chain buffer")]
    InvalidTriggerTxSignature,

    #[msg("Lock period has not elapsed")]
    LockPeriodNotElapsed,

    #[msg("Attestation was priced for a different agent mandate")]
    AttestationMandateMismatch,

    #[msg("Payout exceeds coverage amount")]
    PayoutExceedsCoverage,

    #[msg("Policy is not in ClaimPending state")]
    PolicyNotClaimPending,

    // -- Vault Errors --
    #[msg("Insufficient vault balance for payout")]
    InsufficientVaultBalance,

    #[msg("Protocol is paused — no new policies or stakes")]
    ProtocolPaused,

    #[msg("Solvency ratio too low for this risk tier")]
    SolvencyTooLow,

    // -- Staking Errors --
    #[msg("Stake amount must be greater than zero")]
    ZeroStakeAmount,

    #[msg("Unstake cooldown period not elapsed (48 hours)")]
    UnstakeCooldownNotElapsed,

    #[msg("No unstake request found")]
    NoUnstakeRequest,

    #[msg("No pending rewards to claim")]
    NoRewardsToClaim,

    // -- Auth Errors --
    #[msg("Unauthorized: only oracle authority can verify claims")]
    UnauthorizedOracle,

    #[msg("Unauthorized: only admin can modify config")]
    UnauthorizedAdmin,

    #[msg("Unauthorized: only policy holder can perform this action")]
    UnauthorizedHolder,

    // -- Token Account Errors --
    #[msg("Invalid token account: wrong owner or mint")]
    InvalidTokenAccount,

    // -- Attestation Errors --
    #[msg("Risk attestation has expired — re-assess the agent")]
    AttestationExpired,

    #[msg("Risk attestation agent does not match the policy's agent address")]
    AttestationAgentMismatch,

    #[msg("Invalid attestation validity window (must be > 0 and <= 1 hour)")]
    InvalidAttestationValidity,

    // -- Price Evidence Errors --
    #[msg("Price evidence is malformed, for the wrong feed, or at the wrong exponent")]
    InvalidPriceEvidence,

    #[msg("Signed price was not published close enough to the trigger transaction")]
    PriceEvidenceSkew,

    #[msg("Trigger transaction falls outside the policy's claim window")]
    PriceEvidenceOutOfWindow,

    #[msg("Deviation from the signed reference price is below the provable minimum")]
    DeviationBelowMinimum,

    #[msg("Payout exceeds the loss the signed price can account for")]
    PayoutExceedsProvenLoss,

    // -- Balance Evidence Errors --
    #[msg("No balance checkpoint exists for this policy")]
    CheckpointMissing,

    #[msg("Balance checkpoint is too old, or was taken after the claim was filed")]
    CheckpointOutOfWindow,

    #[msg("Observed balance drop is below the provable minimum")]
    DropBelowMinimum,

    #[msg("Payout exceeds the balance drop the program observed")]
    PayoutExceedsObservedDrop,

    #[msg("Covered token account does not belong to the policy's agent")]
    InvalidCoveredAccount,

    // -- Governance Evidence Errors --
    #[msg("No governance baseline has been declared for this policy")]
    GovernanceBaselineMissing,

    #[msg("Governance baseline had not matured when the claim was filed")]
    GovernanceBaselineNotMatured,

    #[msg("Governance baseline is malformed — declare a real token owner")]
    InvalidGovernanceBaseline,

    #[msg("Too many extra authorities for the governance baseline")]
    TooManyGovernanceAuthorities,

    #[msg("No authority checkpoint exists for this policy")]
    AuthorityCheckpointMissing,

    #[msg("Authority checkpoint is too old, or was taken after the claim was filed")]
    AuthorityCheckpointOutOfWindow,

    #[msg("Control over the covered account is still inside the declared set")]
    AuthorityWithinBaseline,

    #[msg("Payout exceeds the value the program can see was lost or seized")]
    PayoutExceedsProvenGovernanceLoss,

    // -- Agent Mandate Errors --
    #[msg("No agent mandate has been declared for this policy")]
    AgentMandateMissing,

    #[msg("Agent mandate had not matured when the claim was filed")]
    AgentMandateNotMatured,

    #[msg("Agent mandate is malformed — declare a real spending envelope")]
    InvalidAgentMandate,

    #[msg("Too many declared counterparties for the agent mandate")]
    TooManyMandateCounterparties,

    #[msg("Too many declared programs for the agent mandate")]
    TooManyMandatePrograms,

    #[msg("The observed outflow stayed inside the declared mandate")]
    OutflowWithinMandate,

    #[msg("Mandate breach is below the provable minimum")]
    BreachBelowMinimum,

    #[msg("Payout exceeds the mandate breach the program measured")]
    PayoutExceedsProvenBreach,

    // -- Admin Transfer --
    #[msg("Proposed admin must be a real key and not the current admin")]
    InvalidAdminCandidate,

    #[msg("Signer is not the proposed admin")]
    NotProposedAdmin,

    #[msg("Rent refund account is not the admin that opened the proposal")]
    InvalidRentRefund,

    #[msg("Account is not a migratable Covantic account")]
    InvalidAccountForMigration,

    // -- Math Errors --
    #[msg("Arithmetic overflow")]
    MathOverflow,

    #[msg("Payout amount must be greater than zero")]
    ZeroPayout,
}
