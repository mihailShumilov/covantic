use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::PolicyExpiredEvent;
use crate::state::{InsurancePolicy, InsuranceVault};

/// Mark an expired policy as Expired and release its coverage.
/// Permissionless crank — anyone can call this.
///
/// Two shapes of policy can be expired here, and the second is the one that
/// used to have no exit at all:
///
/// - **`Active`, past `expiry_time`.** The ordinary case.
/// - **`ClaimPending`, past `expiry_time`, past its lock, and past
///   `CLAIM_RESOLUTION_GRACE`.** A claim filed just before expiry and never
///   settled — because it sat in review, because the evidence never came
///   together, or because a holder filed it precisely to park the policy —
///   kept `coverage_amount` counted in `vault.total_coverage` forever. Nothing
///   could touch it: `cancel_policy` and this instruction both required
///   `Active`. Repeated across policies that was a way to consume the vault's
///   underwriting capacity without ever taking a payout.
///
/// The grace period is what keeps this from racing a legitimate settlement.
/// A proof instruction becomes callable the moment the lock elapses; a crank
/// that could close the policy at the same instant would turn every slow
/// keeper into a lost claim. A week past the lock is long enough for a claim
/// that landed with a human reviewer, and short enough that "pending" cannot
/// mean "forever".
pub fn expire_policy_handler(ctx: Context<ExpirePolicy>) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    policy.assert_readable()?;

    match policy.state {
        InsurancePolicy::STATE_ACTIVE => {
            require!(now >= policy.expiry_time, CovanticError::PolicyNotExpired);
        }
        InsurancePolicy::STATE_CLAIM_PENDING => {
            require!(now >= policy.expiry_time, CovanticError::PolicyNotExpired);
            // Past the lock, so the settlement instruction has had its turn,
            // and past the grace on top, so a slow keeper is not raced.
            let settle_by = policy
                .claim_submitted_at
                .checked_add(policy.lock_period()?)
                .and_then(|t| t.checked_add(CLAIM_RESOLUTION_GRACE))
                .ok_or(CovanticError::MathOverflow)?;
            require!(now >= settle_by, CovanticError::LockPeriodNotElapsed);
        }
        _ => return Err(CovanticError::PolicyNotActive.into()),
    }

    // Update vault coverage
    vault.total_coverage = vault
        .total_coverage
        .checked_sub(policy.coverage_amount)
        .ok_or(CovanticError::MathOverflow)?;
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
