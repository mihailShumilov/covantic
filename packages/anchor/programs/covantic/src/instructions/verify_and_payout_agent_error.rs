use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::{AgentErrorProofVerified, ClaimPaid};
use crate::state::{
    AgentErrorEvidenceRecord, InsurancePolicy, InsuranceVault, PolicyAgentMandate,
    PolicyBalanceCheckpoint, ProtocolConfig,
};

/// Breach kinds, recorded so a reader knows which declared bound was crossed.
pub const BREACH_OUTFLOW_CAP: u8 = 1;
pub const BREACH_RETAINED_FLOOR: u8 = 2;

/// What the oracle commits to when claiming an agent-error loss.
///
/// Deliberately short, and shorter than it looks like it should be. Everything
/// that could be asserted about *magnitude* has been removed — the program
/// derives that itself below. What remains is a commitment to the off-chain
/// evidence, which is the part the chain cannot check and therefore the part
/// that must be permanently on the record.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AgentErrorPayoutEvidence {
    /// sha256 of the canonical off-chain evidence bundle.
    pub bundle_hash: [u8; 32],
}

/// Verify an agent-error claim against a mandate the holder declared and a
/// balance drop the program measures, then execute payout.
///
/// **What makes this different from the other three proof paths.** An agent
/// error is a loss the agent caused with its own authority — the case
/// `adjudicateExploit` rejects as `agent_authorized_movement`. There is no
/// signed statement about it, no unauthorised signer to point at, and no
/// change of control to observe. The chain has nothing to work with unless
/// somebody says, in advance, what the agent was supposed to be doing.
///
/// `PolicyAgentMandate` is that statement, and it is signed by the holder
/// rather than the operator. So the question this instruction answers is not
/// "did the agent make a mistake?" — which is unanswerable — but "did the
/// agent move more than its owner declared it was permitted to?", which is a
/// subtraction between two numbers the program holds.
///
/// **What the program checks for itself:**
///
/// - The mandate matured *before the claim was filed*, so a holder cannot
///   watch a loss happen and then declare an envelope narrow enough to have
///   been breached by it.
/// - The covered balance, read from an account Anchor derives from the
///   policy's own agent, against a checkpoint written earlier by a
///   permissionless crank.
/// - The overshoot: how far past the declared cap the measured drop landed,
///   or how far below the declared retention floor the account ended up.
/// - That the payout does not exceed that overshoot.
///
/// **What stays trusted, stated plainly.** The chain sees *how much* left. It
/// cannot see *where it went* or *through what*, because it cannot inspect a
/// past transaction — only the covered account's balance now. So the mandate's
/// counterparty and program allowlists are not enforced here. A breach of
/// those dimensions alone produces no overshoot, and this instruction will
/// refuse to settle it: such a claim goes to a reviewer instead.
///
/// That refusal is deliberate and is the difference between this and an
/// earlier draft of the design. Paying a categorical breach bounded only by
/// the measured drop would mean the chain releasing funds on the oracle's
/// unverifiable word about a destination, with no arithmetic constraint the
/// holder had authored. Better to settle a narrower set of claims with an
/// unconditional guarantee — *every proven agent-error payout is bounded by an
/// overshoot above a cap the holder signed for* — than a wider set with a
/// guarantee that has an asterisk.
pub fn verify_and_payout_agent_error_handler(
    ctx: Context<VerifyAndPayoutAgentError>,
    payout_amount: u64,
    evidence: AgentErrorPayoutEvidence,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let policy = &mut ctx.accounts.policy;
    let vault_info = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;
    let mandate = &ctx.accounts.mandate;
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

    // This path proves a *mandate breach*. It has nothing to say about a
    // mispriced fill, an unauthorised drain, or a governance takeover, and
    // must not wave one through.
    require!(
        policy.trigger_type == TRIGGER_AGENT_ERROR,
        CovanticError::InvalidTriggerType
    );

    require!(
        payout_amount <= policy.coverage_amount,
        CovanticError::PayoutExceedsCoverage
    );

    // The coverage, and nothing narrower. This is a claim being paid.
    //
    // There was a second bound here for a while: never more than the premium
    // the policy was bought for. It closed the case where a holder walks their
    // own agent past its cap and collects — this being the one trigger where
    // the holder controls the actor — and it worked, because profit is payout
    // minus premium and the bound made that zero.
    //
    // It also made the cover worthless, which is not a trade insurance makes.
    // Premiums are pooled: many holders pay a little, few claim, and the ones
    // who claim are paid in full. A policy that returns what it cost is a
    // deposit with extra steps.
    //
    // Two things carry the risk instead, and neither is a bound on the amount.
    // The envelope is derived from the agent's own record rather than chosen
    // by the holder, so a breach means the agent moved several times what it
    // ordinarily moves — an anomaly to arrange, not an arithmetic certainty to
    // declare. And the payout is only the overshoot past that cap, so the
    // first slice of every breach is a deductible the holder carries. What is
    // left is ordinary moral hazard, which underwriting answers, not a
    // `require!`.

    // A zero payout transfers nothing but still flips the policy to
    // `ClaimPaid` and releases the coverage — closing a live claim for free.
    // Nothing legitimate submits one.
    require!(payout_amount > 0, CovanticError::ZeroPayout);

    let lock_expires_at = policy
        .claim_submitted_at
        .checked_add(LOCK_AGENT_ERROR)
        .ok_or(CovanticError::MathOverflow)?;
    require!(now >= lock_expires_at, CovanticError::LockPeriodNotElapsed);

    // ---- the declared envelope --------------------------------------------
    // A mandate refreshed after the claim was filed describes the aftermath.
    // `envelope_at` falls back to the declaration it replaced, for the same
    // reason the checkpoint below retains `prev_*`.
    require!(
        mandate.effective_at > 0 || mandate.prev_effective_at > 0,
        CovanticError::AgentMandateMissing
    );
    let (declared_cap, declared_floor, mandate_effective_at) =
        mandate.envelope_at(policy.claim_submitted_at);
    require!(
        mandate_effective_at > 0 && mandate_effective_at <= policy.claim_submitted_at,
        CovanticError::AgentMandateNotMatured
    );
    // A zero cap would make every outflow a breach of unbounded size. The
    // declare handler rejects it, and this refuses to settle against one that
    // reached the account some other way.
    require!(declared_cap > 0, CovanticError::InvalidAgentMandate);

    // ---- pick the baseline ------------------------------------------------
    // Identical rule to the exploit path: a checkpoint written after the claim
    // was filed describes the aftermath, and the reading it replaced is the
    // one that still predates the incident.
    require!(checkpoint.slot > 0, CovanticError::CheckpointMissing);
    require!(
        checkpoint.covered_account == ctx.accounts.covered_token_account.key(),
        CovanticError::InvalidCoveredAccount
    );

    // Two reasons to reach past the current reading for the baseline.
    //
    // The original one: the checkpoint was taken after the claim was filed, so
    // it cannot describe the state the claim is about.
    //
    // The one that was missing: `checkpoint_balance` pins the reading that
    // preceded a drop into `prev_*`, and that pin is precisely the
    // pre-incident balance this instruction needs. A tick between the incident
    // and the claim leaves a post-drain figure in `checkpoint.amount` with a
    // timestamp that still predates the claim — so the first rule alone chose
    // it, subtracted it from itself, and found a drop of zero on a real theft.
    // Prefer the pin whenever it is higher and it, too, predates the claim.
    let pin_usable = checkpoint.prev_unix_timestamp > 0
        && checkpoint.prev_unix_timestamp <= policy.claim_submitted_at
        && checkpoint.prev_amount > checkpoint.amount;

    let (baseline_amount, baseline_slot, baseline_time) =
        if checkpoint.unix_timestamp <= policy.claim_submitted_at && !pin_usable {
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
        CovanticError::CheckpointOutOfWindow
    );
    // A balance from before the policy existed is not something this policy
    // insured.
    require!(
        baseline_time >= policy.start_time,
        CovanticError::CheckpointOutOfWindow
    );
    // Staleness is measured against `claim_submitted_at`, **not `now`**, and
    // here that is a necessity rather than a refinement. `LOCK_AGENT_ERROR` is
    // six hours; `MAX_MANDATE_CHECKPOINT_AGE` is two. Comparing against `now`
    // — as `verify_and_payout_exploit` does, where a one-hour lock leaves an
    // hour of slack — would make every payout on this path unsatisfiable the
    // moment it became callable. Do not "align" the two.
    let age = policy
        .claim_submitted_at
        .checked_sub(baseline_time)
        .ok_or(CovanticError::MathOverflow)?;
    require!(
        age <= MAX_MANDATE_CHECKPOINT_AGE,
        CovanticError::CheckpointOutOfWindow
    );

    // ---- measure the drop -------------------------------------------------
    let current_amount = ctx.accounts.covered_token_account.amount;
    let observed_drop = baseline_amount.saturating_sub(current_amount);
    require!(observed_drop > 0, CovanticError::DropBelowMinimum);

    // ---- measure the breach ------------------------------------------------
    // Two quantitative dimensions, both re-derived here from numbers the
    // program read. Whichever produced the larger overshoot names the breach.
    let cap_excess = observed_drop.saturating_sub(declared_cap);

    // How far below the declared retention floor the account ended up —
    // clamped to the drop, because value that left before this window is not
    // something this claim may reach back for.
    let floor_excess = declared_floor
        .saturating_sub(current_amount)
        .min(observed_drop);

    let (breach_excess, breach_kind) = if cap_excess >= floor_excess {
        (cap_excess, BREACH_OUTFLOW_CAP)
    } else {
        (floor_excess, BREACH_RETAINED_FLOOR)
    };

    // The agent stayed inside what its owner declared. That is not a covered
    // event, whatever the off-chain evidence says about the destination: a
    // breach the chain cannot measure is one it will not settle.
    require!(breach_excess > 0, CovanticError::OutflowWithinMandate);
    require!(
        breach_excess >= MIN_PROVABLE_MANDATE_BREACH,
        CovanticError::BreachBelowMinimum
    );

    // The bound. Every input is a number this program read or derived for
    // itself, so anyone holding the checkpoint and the mandate can recompute
    // it.
    require!(
        payout_amount <= breach_excess,
        CovanticError::PayoutExceedsProvenBreach
    );

    // ---- payout ------------------------------------------------------------
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

    // Loss cascade, identical to every other payout path: treasury, then
    // reserve, then staker principal. Kept in step deliberately — a payout
    // must have the same effect on solvency however it was proven.
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

    // ---- record what was measured -------------------------------------------
    let record = &mut ctx.accounts.evidence_record;
    record.policy_id = policy.policy_id;
    record.holder = policy.holder;
    record.covered_account = ctx.accounts.covered_token_account.key();
    record.declared_max_single_outflow = declared_cap;
    record.declared_min_retained_balance = declared_floor;
    record.mandate_effective_at = mandate_effective_at;
    record.checkpoint_amount = baseline_amount;
    record.checkpoint_slot = baseline_slot;
    record.checkpoint_unix_timestamp = baseline_time;
    record.current_amount = current_amount;
    record.observed_drop = observed_drop;
    record.breach_excess = breach_excess;
    record.breach_kind = breach_kind;
    record.max_provable_loss = breach_excess;
    record.payout_amount = payout_amount;
    record.bundle_hash = evidence.bundle_hash;
    record.verified_at = now;
    record.bump = ctx.bumps.evidence_record;

    emit!(AgentErrorProofVerified {
        policy_id: policy.policy_id,
        covered_account: record.covered_account,
        declared_max_single_outflow: declared_cap,
        declared_min_retained_balance: declared_floor,
        mandate_effective_at,
        checkpoint_amount: baseline_amount,
        current_amount,
        observed_drop,
        breach_excess,
        breach_kind,
        max_provable_loss: breach_excess,
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

#[derive(Accounts)]
pub struct VerifyAndPayoutAgentError<'info> {
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

    /// The covered account, re-read at payout time.
    ///
    /// Derived by Anchor from the policy's own agent address, exactly as in
    /// `checkpoint_balance`. This is what makes the drop a measurement rather
    /// than an assertion: the caller cannot point the subtraction at an
    /// account of its choosing.
    ///
    /// `associated_token::authority` is correct *here*, unlike on the
    /// governance path: an agent error is by definition something the agent
    /// did while still owning its account, so the owner-equality check this
    /// compiles into is a constraint rather than an obstacle. A policy whose
    /// account has changed hands is a governance claim, and this instruction
    /// failing to load it is the right outcome.
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = policy.agent_address,
    )]
    pub covered_token_account: Box<Account<'info, TokenAccount>>,

    #[account(constraint = usdc_mint.key() == config.usdc_mint @ CovanticError::InvalidTokenAccount)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [AGENT_MANDATE_SEED, policy.key().as_ref()],
        bump = mandate.bump,
    )]
    pub mandate: Box<Account<'info, PolicyAgentMandate>>,

    #[account(
        seeds = [CHECKPOINT_SEED, policy.key().as_ref()],
        bump = checkpoint.bump,
    )]
    pub checkpoint: Box<Account<'info, PolicyBalanceCheckpoint>>,

    /// Immutable record of what was measured. `init` rather than
    /// `init_if_needed`: one policy, one proven payout, and a second attempt
    /// should fail loudly rather than overwrite the first.
    #[account(
        init,
        payer = oracle,
        space = AgentErrorEvidenceRecord::LEN,
        seeds = [AGENT_ERROR_EVIDENCE_SEED, policy.key().as_ref()],
        bump,
    )]
    pub evidence_record: Box<Account<'info, AgentErrorEvidenceRecord>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
