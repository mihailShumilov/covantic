use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::{ClaimPaid, GovernanceProofVerified};
use crate::instructions::checkpoint_authority::observe;
use crate::state::{
    AuthorityReading, BaselineView, GovernanceBaseline, GovernanceEvidenceRecord, InsurancePolicy,
    InsuranceVault, PolicyAuthorityCheckpoint, ProtocolConfig,
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
/// The only path where the chain establishes the covered *event* rather than
/// merely bounding its size. It rests on three things the program holds and
/// the oracle asserts none of:
///
///   - **A declaration.** The holder said, in advance and under their own
///     signature, who may control the agent. The declaration in force is the
///     one that had matured when the claim was filed — a refresh that landed
///     later describes the aftermath, and the one it replaced is consulted
///     instead.
///   - **A reading from before.** A checkpoint the program wrote itself,
///     taken at or before the claim, showing control *inside* the declared
///     set. Without one there is no transition to prove: an account that was
///     already under an outside key when the first reading was taken is not
///     something this instruction witnessed changing hands, and a holder who
///     arranged that state themselves must not be able to present it as a
///     takeover. The reading must also be recent — no older than
///     `GOVERNANCE_DRAIN_WINDOW` when the claim was filed — and the
///     declaration must have matured before it was taken, so the reading
///     really does describe a state the holder had already consented to.
///   - **The account as it is now.** Read live, derived from the policy's own
///     agent rather than accepted from the caller.
///
/// A departure is the pair: control inside the declared set before, outside
/// it now. The payout is bounded by what the program can see was lost or
/// seized between those two readings.
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
    policy.assert_readable()?;
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

    // The record this instruction leaves behind is only worth something if
    // the hash in it commits to a bundle somebody can go and check.
    require!(
        evidence.bundle_hash != [0u8; 32],
        CovanticError::EvidenceBundleHashMissing
    );

    let lock_expires_at = policy
        .claim_submitted_at
        .checked_add(LOCK_GOVERNANCE_ATTACK)
        .ok_or(CovanticError::MathOverflow)?;
    require!(now >= lock_expires_at, CovanticError::LockPeriodNotElapsed);

    let claim_at = policy.claim_submitted_at;

    // ---- the holder's own declaration --------------------------------------
    require!(
        baseline.policy_id == policy.policy_id && baseline.holder == policy.holder,
        CovanticError::GovernanceBaselineMissing
    );
    require!(
        baseline.effective_at > 0 || baseline.prev_effective_at > 0,
        CovanticError::GovernanceBaselineMissing
    );
    // The declaration that was in force when the claim was filed: the current
    // one if it had matured by then, otherwise the whole predecessor it
    // replaced. A refresh landing between the incident and the claim must
    // not make the declaration that governed the incident disappear.
    let declared = baseline
        .view_at(claim_at)
        .ok_or(CovanticError::GovernanceBaselineNotMatured)?;

    // ---- what the program recorded before ----------------------------------
    require!(
        checkpoint.slot > 0,
        CovanticError::AuthorityCheckpointMissing
    );
    require!(
        checkpoint.covered_account == ctx.accounts.covered_token_account.key(),
        CovanticError::InvalidCoveredAccount
    );

    // The "before" is the latest reading, taken at or before the claim, in
    // which control sat inside the declared set. The current reading is
    // preferred; when the crank ticked between the takeover and the claim it
    // already shows the aftermath, and the predecessor it pinned — the
    // reading immediately before control changed — is the one that still
    // describes the state consented to. A first reading with no predecessor,
    // or two readings both outside the set, prove no transition at all.
    let before = select_before(checkpoint, &declared, policy, claim_at)?;

    require!(
        before.unix_timestamp >= policy.start_time,
        CovanticError::AuthorityCheckpointOutOfWindow
    );
    // Staleness is measured against the *claim*, not against now, and the
    // distinction is not cosmetic — it is the difference between this bound
    // working and being unsatisfiable: this trigger's lock is two hours, and
    // measuring against `now` would fold it into every allowance below.
    let staleness = claim_at
        .checked_sub(before.unix_timestamp)
        .ok_or(CovanticError::MathOverflow)?;
    require!(
        staleness <= MAX_AUTHORITY_CHECKPOINT_AGE,
        CovanticError::AuthorityCheckpointOutOfWindow
    );
    // The window the coverage table has advertised since launch, enforced.
    // A reading older than this cannot establish that the takeover the claim
    // describes is the one that caused the loss measured below; a claim that
    // far from its last permitted reading goes to a reviewer.
    require!(
        staleness <= GOVERNANCE_DRAIN_WINDOW,
        CovanticError::AuthorityCheckpointOutsideDrainWindow
    );
    // The declaration must have been usable as proof when the permitted
    // reading was taken. Binding maturity to the claim alone let a holder
    // install the outside key, declare afterwards, wait for maturity, and
    // file — the declaration then postdated the takeover it was judging.
    require!(
        declared.effective_at <= before.unix_timestamp,
        CovanticError::GovernanceBaselineNotMatured
    );

    // ---- what the program reads now ----------------------------------------
    let covered = &ctx.accounts.covered_token_account;
    let observed = observe(covered, &clock);

    let (departure_kind, departed_to) = classify_departure(
        &declared,
        policy,
        &before,
        &observed,
        checkpoint.covered_account,
    )?;

    // ---- bound the payout ---------------------------------------------------
    //
    // Two disjoint numbers, and taking the larger rather than the sum is not
    // conservatism — it is correctness. For a single account they are
    // complementary: value that left is no longer sitting there, and value
    // sitting there did not leave. Adding them would count the same dollars
    // twice in the one case that matters most, a seizure followed by a drain.
    let current_amount = observed.amount;
    let observed_drop = before.amount.saturating_sub(current_amount);
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
    // Waterfall: treasury, then reserve, then staker principal — and the
    // staker leg moves `loss_index` in step, so the loss is actually
    // socialised instead of landing on whoever withdraws last.
    vault.absorb_loss(payout_amount)?;

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
    record.declared_owner = declared.token_owner;
    record.observed_owner = observed.owner;
    record.observed_frozen = observed.frozen;
    record.departure_kind = departure_kind;
    record.departed_to = departed_to;
    record.checkpoint_amount = before.amount;
    record.checkpoint_slot = before.slot;
    record.checkpoint_unix_timestamp = before.unix_timestamp;
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
        observed_owner: observed.owner,
        observed_frozen: observed.frozen,
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

/// The latest checkpointed reading, at or before the claim, in which control
/// sat inside the declared set.
fn select_before(
    checkpoint: &PolicyAuthorityCheckpoint,
    declared: &BaselineView,
    policy: &InsurancePolicy,
    claim_at: i64,
) -> Result<AuthorityReading> {
    let inside = |reading: &AuthorityReading| -> bool {
        reading.unix_timestamp > 0
            && reading.unix_timestamp <= claim_at
            && declared.covers(reading, &policy.holder, &policy.agent_address)
    };

    let current = checkpoint.current();
    if inside(&current) {
        return Ok(current);
    }
    if let Some(prev) = checkpoint.predecessor() {
        if inside(&prev) {
            return Ok(prev);
        }
    }
    err!(CovanticError::AuthorityTransitionUnproven)
}

/// Establish that control actually left the declared set, and say how.
///
/// Errors rather than returning a "no departure" variant: there is no payout
/// to make without one, and the caller must not be able to proceed past this
/// with a default.
///
/// `before` is a reading the caller has already established sits inside the
/// declared set, so each branch below is a transition — permitted then, not
/// permitted now — rather than a bare observation of the present.
///
/// The holder and the agent are folded into the permitted set here. Control
/// that moved between them never left the family, whatever the manifest says
/// about the specific address — a holder who rotates their agent's account to
/// their own wallet has not been attacked.
fn classify_departure(
    declared: &BaselineView,
    policy: &InsurancePolicy,
    before: &AuthorityReading,
    observed: &AuthorityReading,
    covered_account: Pubkey,
) -> Result<(u8, Pubkey)> {
    // Role-keyed: a key the holder declared as a *delegate* is not thereby
    // permitted to become the account's *owner*. Asking the flat question let
    // an attacker read this public account and name the declared delegate as
    // the new owner, landing a real seizure inside the declared set.
    let permitted = |candidate: &Pubkey, role: u8| -> bool {
        candidate == &policy.holder
            || candidate == &policy.agent_address
            || declared.permits_role(candidate, role)
    };

    // Ordered by how completely each one removes the agent's control. An
    // owner change is total; a delegate is partial and might be routine.
    if !permitted(&observed.owner, DEPARTURE_OWNER) {
        return Ok((DEPARTURE_OWNER, observed.owner));
    }

    if observed.frozen && !before.frozen {
        // A freeze has no "new authority" on the account itself — the mint's
        // freeze authority did it, and the account records only the fact. The
        // account is named as the subject so the record is not left blank.
        return Ok((DEPARTURE_FROZEN, covered_account));
    }

    if let Some(close_authority) = observed.close_authority {
        if !permitted(&close_authority, DEPARTURE_CLOSE_AUTHORITY) {
            return Ok((DEPARTURE_CLOSE_AUTHORITY, close_authority));
        }
    }

    if let Some(delegate) = observed.delegate {
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
