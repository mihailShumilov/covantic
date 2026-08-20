use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::{ClaimPaid, GovernanceProofVerified};
use crate::state::{
    GovernanceBaseline, GovernanceEvidenceRecord, InsurancePolicy, InsuranceVault,
    PolicyAuthorityCheckpoint, ProtocolConfig,
};

/// What the oracle commits to when claiming a governance loss.
///
/// Deliberately short — shorter than either of the other proof paths. Nothing
/// about *who controls the account* is asserted here, because the program
/// reads that for itself below, and nothing about magnitude is asserted
/// either, because the program bounds that too. What remains is a commitment
/// to the off-chain evidence, which is the part the chain cannot check and
/// therefore the part that must be permanently on the record.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GovernancePayoutEvidence {
    /// sha256 of the canonical off-chain evidence bundle.
    pub bundle_hash: [u8; 32],
}


/// Verify a governance claim against a departure the program observes, and
/// execute payout.
///
/// **This is the strongest of the three proof paths, and it is worth being
/// precise about why.**
///
/// `verify_and_payout_v2` checks a guardian-signed price, but the swap it is
/// pricing is asserted by the oracle — the chain cannot read a historical
/// fill. `verify_and_payout_exploit` measures a balance drop for itself, but
/// it cannot see *why* the money left; a self-drain and a theft subtract
/// identically. In both, the covered *event* remains an off-chain claim and
/// only its magnitude is constrained.
///
/// Here the covered event is on-chain state. Who controls a token account is
/// a field on that account, readable now and recorded earlier by a
/// permissionless crank — and, uniquely, the holder has already said under
/// their own signature who is allowed to hold it. So the program does not
/// take the oracle's word for the takeover; it performs the comparison:
///
///   1. the holder's declaration, matured before the claim was filed;
///   2. the authority the program itself recorded before the incident;
///   3. the authority the program reads right now.
///
/// A payout requires (3) to sit outside (1). The oracle chooses nothing.
///
/// **What remains trusted, stated plainly.** The chain can see that control
/// left the declared set and that it did not land on the holder or the agent.
/// It cannot see whether the new controller is a *second wallet the holder
/// also owns*. That residual is the same one the exploit path carries with
/// destination control, and it is bounded the same way — the committed
/// bundle, the two-hour lock, the payout circuit breaker — plus one thing
/// neither other path has: the holder had to pre-commit to a manifest an hour
/// before the incident and then depart from it, on chain, in public.
///
/// **A note on what cannot be proven here.** If the covered account was
/// *closed* rather than seized, it no longer exists and this instruction
/// cannot load it. That case is not a gap in practice: closing an SPL token
/// account requires emptying it first, so the loss is a drain and the exploit
/// path measures it. A close with nothing in the account costs nothing.
pub fn verify_and_payout_governance_handler(
    ctx: Context<VerifyAndPayoutGovernance>,
    payout_amount: u64,
    evidence: GovernancePayoutEvidence,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let policy = &mut ctx.accounts.policy;
    let vault_info = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;
    let baseline = &ctx.accounts.baseline;
    let checkpoint = &ctx.accounts.checkpoint;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    require!(!config.paused, CovanticError::ProtocolPaused);
    require!(
        ctx.accounts.oracle.key() == config.oracle_authority,
        CovanticError::UnauthorizedOracle
    );
    require!(
        policy.state == InsurancePolicy::STATE_CLAIM_PENDING,
        CovanticError::PolicyNotClaimPending
    );

    // This path proves a *takeover*. It has nothing to say about a mispriced
    // fill or a plain drain, and must not wave either through.
    require!(
        policy.trigger_type == TRIGGER_GOVERNANCE_ATTACK,
        CovanticError::InvalidTriggerType
    );
    require!(
        payout_amount <= policy.coverage_amount,
        CovanticError::PayoutExceedsCoverage
    );

    // A zero payout transfers nothing but still flips the policy to
    // `ClaimPaid` and releases the coverage — closing a live claim for free.
    // Nothing legitimate submits one.
    require!(payout_amount > 0, CovanticError::ZeroPayout);

    let lock_expires_at = policy
        .claim_submitted_at
        .checked_add(LOCK_GOVERNANCE_ATTACK)
        .ok_or(CovanticError::MathOverflow)?;
    require!(now >= lock_expires_at, CovanticError::LockPeriodNotElapsed);

    // ---- the holder's own declaration --------------------------------------
    require!(
        baseline.policy_id == policy.policy_id && baseline.holder == policy.holder,
        CovanticError::GovernanceBaselineMissing
    );
    require!(
        baseline.effective_at > 0,
        CovanticError::GovernanceBaselineMissing
    );
    // Matured *before the incident*, not merely before now. A declaration
    // written after the claim was filed describes the aftermath, and one
    // written in the same breath as the claim proves nothing at all.
    require!(
        baseline.effective_at <= policy.claim_submitted_at,
        CovanticError::GovernanceBaselineNotMatured
    );

    // ---- what the program recorded before ----------------------------------
    require!(checkpoint.slot > 0, CovanticError::AuthorityCheckpointMissing);
    require!(
        checkpoint.covered_account == ctx.accounts.covered_token_account.key(),
        CovanticError::InvalidCoveredAccount
    );

    // A checkpoint written after the claim describes the aftermath. When the
    // crank happens to tick between the takeover and the claim, the reading
    // it replaced is the one that still predates the incident — which is
    // exactly why `prev_*` is retained.
    let (baseline_amount, baseline_slot, baseline_time) =
        if checkpoint.unix_timestamp <= policy.claim_submitted_at {
            (checkpoint.amount, checkpoint.slot, checkpoint.unix_timestamp)
        } else {
            (
                checkpoint.prev_amount,
                checkpoint.prev_slot,
                checkpoint.prev_unix_timestamp,
            )
        };

    require!(
        baseline_time > 0 && baseline_time <= policy.claim_submitted_at,
        CovanticError::AuthorityCheckpointOutOfWindow
    );
    require!(
        baseline_time >= policy.start_time,
        CovanticError::AuthorityCheckpointOutOfWindow
    );
    // Staleness is measured against the *claim*, not against now, and the
    // distinction is not cosmetic — it is the difference between this bound
    // working and being unsatisfiable.
    //
    // The question the bound is asking is "did this reading describe the
    // situation just before the incident?", which is answered by how old it
    // was when the claim was filed. Measuring against `now` instead folds the
    // lock period into the answer, and this trigger's lock is two hours —
    // exactly the staleness allowance — so a checkpoint taken moments before
    // a takeover would always be judged too old by the time it could be
    // settled. Every governance payout would fail.
    let staleness = policy
        .claim_submitted_at
        .checked_sub(baseline_time)
        .ok_or(CovanticError::MathOverflow)?;
    require!(
        staleness <= MAX_AUTHORITY_CHECKPOINT_AGE,
        CovanticError::AuthorityCheckpointOutOfWindow
    );

    // ---- what the program reads now ----------------------------------------
    let covered = &ctx.accounts.covered_token_account;
    let observed_owner = covered.owner;
    let observed_frozen = covered.is_frozen();
    let observed_delegate: Option<Pubkey> = covered.delegate.into();
    let observed_close_authority: Option<Pubkey> = covered.close_authority.into();

    let (departure_kind, departed_to) = classify_departure(
        baseline,
        policy,
        observed_owner,
        observed_frozen,
        observed_delegate,
        observed_close_authority,
        checkpoint,
    )?;

    // ---- bound the payout ---------------------------------------------------
    //
    // Two disjoint numbers, and taking the larger rather than the sum is not
    // conservatism — it is correctness. For a single account they are
    // complementary: value that left is no longer sitting there, and value
    // sitting there did not leave. Adding them would count the same dollars
    // twice in the one case that matters most, a seizure followed by a drain.
    let current_amount = covered.amount;
    let observed_drop = baseline_amount.saturating_sub(current_amount);
    // Only value the agent can no longer *reach* counts as seized, and that
    // is a narrower set than "a departure happened".
    //
    //   - An owner change removes the agent's access entirely.
    //   - A freeze does the same without moving anything.
    //   - A delegate does not: an allowance lets someone else spend, but the
    //     agent can still spend too, so nothing is lost until it is drawn —
    //     and what is drawn shows up in `observed_drop`.
    //   - A close authority does not either, and cannot: SPL Token refuses to
    //     close a non-empty account, so whoever holds it must drain first,
    //     which again lands in `observed_drop`.
    //
    // Counting the standing balance as seized for those last two would pay
    // out the whole account for a capability that has taken nothing.
    let seized_amount = match departure_kind {
        DEPARTURE_OWNER | DEPARTURE_FROZEN => current_amount,
        _ => 0,
    };
    let max_provable_loss = observed_drop.max(seized_amount);

    require!(
        max_provable_loss >= MIN_PROVABLE_GOVERNANCE_LOSS,
        CovanticError::PayoutExceedsProvenGovernanceLoss
    );
    require!(
        payout_amount <= max_provable_loss,
        CovanticError::PayoutExceedsProvenGovernanceLoss
    );

    // ---- payout -------------------------------------------------------------
    require!(
        ctx.accounts.vault_token_account.amount >= payout_amount,
        CovanticError::InsufficientVaultBalance
    );

    let vault_bump = vault.bump;
    let seeds = &[VAULT_SEED, &[vault_bump]];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.holder_token_account.to_account_info(),
            authority: vault_info.clone(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, payout_amount)?;

    vault.total_claims_paid = vault
        .total_claims_paid
        .checked_add(payout_amount)
        .ok_or(CovanticError::MathOverflow)?;

    // Loss cascade, identical to every other payout path. Kept in step
    // deliberately: a payout must have the same effect on solvency however it
    // was proven.
    let mut remaining = payout_amount;

    let from_treasury = remaining.min(vault.protocol_treasury);
    vault.protocol_treasury = vault
        .protocol_treasury
        .checked_sub(from_treasury)
        .ok_or(CovanticError::MathOverflow)?;
    remaining = remaining
        .checked_sub(from_treasury)
        .ok_or(CovanticError::MathOverflow)?;

    let from_reserve = remaining.min(vault.reserve_fund);
    vault.reserve_fund = vault
        .reserve_fund
        .checked_sub(from_reserve)
        .ok_or(CovanticError::MathOverflow)?;
    remaining = remaining
        .checked_sub(from_reserve)
        .ok_or(CovanticError::MathOverflow)?;

    if remaining > 0 {
        vault.total_staked = vault
            .total_staked
            .checked_sub(remaining)
            .ok_or(CovanticError::InsufficientVaultBalance)?;
    }

    vault.total_coverage = vault
        .total_coverage
        .checked_sub(policy.coverage_amount)
        .ok_or(CovanticError::MathOverflow)?;
    vault.recalculate_solvency();

    policy.state = InsurancePolicy::STATE_CLAIM_PAID;
    policy.payout_amount = payout_amount;

    // ---- record what was observed -------------------------------------------
    let record = &mut ctx.accounts.evidence_record;
    record.policy_id = policy.policy_id;
    record.holder = policy.holder;
    record.covered_account = covered.key();
    record.declared_owner = baseline.token_owner;
    record.observed_owner = observed_owner;
    record.observed_frozen = observed_frozen;
    record.departure_kind = departure_kind;
    record.departed_to = departed_to;
    record.checkpoint_amount = baseline_amount;
    record.checkpoint_slot = baseline_slot;
    record.checkpoint_unix_timestamp = baseline_time;
    record.current_amount = current_amount;
    record.observed_drop = observed_drop;
    record.seized_amount = seized_amount;
    record.max_provable_loss = max_provable_loss;
    record.payout_amount = payout_amount;
    record.bundle_hash = evidence.bundle_hash;
    record.verified_at = now;
    record.bump = ctx.bumps.evidence_record;

    emit!(GovernanceProofVerified {
        policy_id: policy.policy_id,
        covered_account: record.covered_account,
        declared_owner: record.declared_owner,
        observed_owner,
        observed_frozen,
        departure_kind,
        departed_to,
        observed_drop,
        seized_amount,
        max_provable_loss,
        payout_amount,
        bundle_hash: evidence.bundle_hash,
    });

    emit!(ClaimPaid {
        policy_id: policy.policy_id,
        holder: policy.holder,
        payout_amount,
        trigger_type: policy.trigger_type,
        paid_at: now,
    });

    Ok(())
}

/// Establish that control actually left the declared set, and say how.
///
/// Errors rather than returning a "no departure" variant: there is no payout
/// to make without one, and the caller must not be able to proceed past this
/// with a default.
///
/// The holder and the agent are folded into the permitted set here. Control
/// that moved between them never left the family, whatever the manifest says
/// about the specific address — a holder who rotates their agent's account to
/// their own wallet has not been attacked.
fn classify_departure(
    baseline: &GovernanceBaseline,
    policy: &InsurancePolicy,
    observed_owner: Pubkey,
    observed_frozen: bool,
    observed_delegate: Option<Pubkey>,
    observed_close_authority: Option<Pubkey>,
    checkpoint: &PolicyAuthorityCheckpoint,
) -> Result<(u8, Pubkey)> {
    // Role-keyed: a key the holder declared as a *delegate* is not thereby
    // permitted to become the account's *owner*. Asking the flat question let
    // an attacker read this public account and name the declared delegate as
    // the new owner, landing a real seizure inside the declared set.
    let permitted = |candidate: &Pubkey, role: u8| -> bool {
        candidate == &policy.holder
            || candidate == &policy.agent_address
            || baseline.permits_role(candidate, role)
    };

    // Ordered by how completely each one removes the agent's control. An
    // owner change is total; a delegate is partial and might be routine.
    if !permitted(&observed_owner, DEPARTURE_OWNER) {
        return Ok((DEPARTURE_OWNER, observed_owner));
    }

    if observed_frozen && !checkpoint.prev_frozen {
        // A freeze has no "new authority" on the account itself — the mint's
        // freeze authority did it, and the account records only the fact. The
        // account is named as the subject so the record is not left blank.
        return Ok((DEPARTURE_FROZEN, checkpoint.covered_account));
    }

    if let Some(close_authority) = observed_close_authority {
        if !permitted(&close_authority, DEPARTURE_CLOSE_AUTHORITY) {
            return Ok((DEPARTURE_CLOSE_AUTHORITY, close_authority));
        }
    }

    if let Some(delegate) = observed_delegate {
        if !permitted(&delegate, DEPARTURE_DELEGATE) {
            return Ok((DEPARTURE_DELEGATE, delegate));
        }
    }

    // Control is exactly where the holder said it should be. This is the
    // clean refusal, and it rests on a positive on-chain fact rather than on
    // the absence of evidence.
    err!(CovanticError::AuthorityWithinBaseline)
}

#[derive(Accounts)]
pub struct VerifyAndPayoutGovernance<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.oracle_authority == oracle.key() @ CovanticError::UnauthorizedOracle,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [POLICY_SEED, policy.holder.as_ref(), &policy.policy_id.to_le_bytes()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, InsurancePolicy>>,

    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, InsuranceVault>>,

    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ CovanticError::InvalidTokenAccount,
        constraint = vault_token_account.mint == config.usdc_mint @ CovanticError::InvalidTokenAccount,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = holder_token_account.owner == policy.holder @ CovanticError::InvalidTokenAccount,
        constraint = holder_token_account.mint == config.usdc_mint @ CovanticError::InvalidTokenAccount,
    )]
    pub holder_token_account: Box<Account<'info, TokenAccount>>,

    /// The covered account, re-read at payout time and derived by *address*.
    ///
    /// Not by `associated_token::authority`, which would compile into an
    /// owner equality check and reject precisely the state this instruction
    /// exists to observe. The caller still cannot choose the account: the
    /// address is computed from the policy's own agent and the config's mint.
    #[account(
        address = get_associated_token_address(&policy.agent_address, &usdc_mint.key())
            @ CovanticError::InvalidCoveredAccount,
    )]
    pub covered_token_account: Box<Account<'info, TokenAccount>>,

    #[account(constraint = usdc_mint.key() == config.usdc_mint @ CovanticError::InvalidTokenAccount)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [GOVERNANCE_BASELINE_SEED, policy.key().as_ref()],
        bump = baseline.bump,
    )]
    pub baseline: Box<Account<'info, GovernanceBaseline>>,

    #[account(
        seeds = [AUTHORITY_CHECKPOINT_SEED, policy.key().as_ref()],
        bump = checkpoint.bump,
    )]
    pub checkpoint: Box<Account<'info, PolicyAuthorityCheckpoint>>,

    /// Immutable record of what was observed. `init` rather than
    /// `init_if_needed`: one policy, one proven payout, and a second attempt
    /// should fail loudly rather than overwrite the first.
    #[account(
        init,
        payer = oracle,
        space = GovernanceEvidenceRecord::LEN,
        seeds = [GOVERNANCE_EVIDENCE_SEED, policy.key().as_ref()],
        bump,
    )]
    pub evidence_record: Box<Account<'info, GovernanceEvidenceRecord>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
