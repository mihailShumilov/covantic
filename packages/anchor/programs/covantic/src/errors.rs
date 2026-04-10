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

    #[msg("Lock period has not elapsed")]
    LockPeriodNotElapsed,

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

    // -- Math Errors --
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
