use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::GovernanceBaselineDeclared;
use crate::state::{GovernanceBaseline, InsurancePolicy};

/// What the holder commits to about who may control their agent.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GovernanceManifest {
    /// Expected owner of the covered token account. Normally the agent.
    pub token_owner: Pubkey,
    pub expected_delegate: Option<Pubkey>,
    pub expected_close_authority: Option<Pubkey>,
    pub program_upgrade_authority: Option<Pubkey>,
    pub controller: Option<Pubkey>,
    pub controller_min_threshold: u16,
    /// Extra addresses permitted to hold control. Capped at
    /// {@link MAX_GOVERNANCE_EXTRA_AUTHORITIES}.
    pub extra_authorities: Vec<Pubkey>,
    /// sha256 of the off-chain manifest covering anything richer.
    pub manifest_hash: [u8; 32],
}

/// Declare — or refresh — the authority set that is legitimate for an agent.
///
/// **Holder-signed, and that is the entire point.** Every other evidence
/// mechanism in this protocol has the operator asserting something about the
/// policyholder's situation. Here the policyholder asserts it themselves, in
/// advance, and the program later checks reality against their own statement.
/// It turns "was this authorised?" from an inference into a set membership
/// test.
///
/// Two rules make the statement worth anything:
///
/// **It matures on a delay.** `effective_at` is `GOVERNANCE_BASELINE_DELAY`
/// in the future, and `verify_and_payout_governance` refuses a baseline that
/// had not matured before the claim was filed. Without that, a stolen holder
/// key would declare a convenient set and claim against it in the next
/// instruction. With it, a fraudulent claim has to be set up on chain, in
/// public, an hour ahead.
///
/// **The previous declaration is retained.** A refresh keeps `prev_*`, so a
/// rotation landing between the takeover and the claim cannot erase the only
/// usable "before" — the same hole `PolicyBalanceCheckpoint.prev_*` closes.
///
/// What the program does *not* do is interpret `manifest_hash`. It cannot
/// decode a Squads config or an allowed-signer list, and pretending it could
/// would be worse than committing to the hash and leaving the richer check to
/// a reader who can perform it.
pub fn declare_governance_baseline_handler(
    ctx: Context<DeclareGovernanceBaseline>,
    manifest: GovernanceManifest,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let policy = &ctx.accounts.policy;

    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE,
        CovanticError::PolicyNotActive
    );
    require!(
        manifest.token_owner != Pubkey::default(),
        CovanticError::InvalidGovernanceBaseline
    );
    require!(
        manifest.extra_authorities.len() <= MAX_GOVERNANCE_EXTRA_AUTHORITIES,
        CovanticError::TooManyGovernanceAuthorities
    );
    // The zero pubkey must never end up in the permitted set: every unset
    // slot in the fixed array is zero, and an attacker who could get control
    // assigned to it would land inside the declared set for free.
    require!(
        !manifest.extra_authorities.contains(&Pubkey::default()),
        CovanticError::InvalidGovernanceBaseline
    );

    let baseline = &mut ctx.accounts.baseline;
    let is_new = baseline.policy_id == 0 && baseline.effective_at == 0;

    let prev_token_owner = if is_new {
        manifest.token_owner
    } else {
        baseline.token_owner
    };
    let prev_effective_at = if is_new { now } else { baseline.effective_at };

    baseline.policy_id = policy.policy_id;
    baseline.holder = policy.holder;
    baseline.token_owner = manifest.token_owner;
    baseline.expected_delegate = manifest.expected_delegate;
    baseline.expected_close_authority = manifest.expected_close_authority;
    baseline.program_upgrade_authority = manifest.program_upgrade_authority;
    baseline.controller = manifest.controller;
    baseline.controller_min_threshold = manifest.controller_min_threshold;

    baseline.extra_authorities = [Pubkey::default(); MAX_GOVERNANCE_EXTRA_AUTHORITIES];
    for (slot, key) in manifest.extra_authorities.iter().enumerate() {
        baseline.extra_authorities[slot] = *key;
    }
    baseline.extra_authority_count = manifest.extra_authorities.len() as u8;

    baseline.manifest_hash = manifest.manifest_hash;
    baseline.declared_at = now;
    baseline.effective_at = now
        .checked_add(GOVERNANCE_BASELINE_DELAY)
        .ok_or(CovanticError::MathOverflow)?;
    baseline.prev_token_owner = prev_token_owner;
    baseline.prev_effective_at = prev_effective_at;
    baseline.bump = ctx.bumps.baseline;

    emit!(GovernanceBaselineDeclared {
        policy_id: baseline.policy_id,
        holder: baseline.holder,
        token_owner: baseline.token_owner,
        extra_authority_count: baseline.extra_authority_count,
        manifest_hash: baseline.manifest_hash,
        declared_at: baseline.declared_at,
        effective_at: baseline.effective_at,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DeclareGovernanceBaseline<'info> {
    /// The policyholder. Nobody else may say who is allowed to control their
    /// agent — least of all the oracle, whose discretion this account exists
    /// to constrain.
    #[account(mut)]
    pub holder: Signer<'info>,

    #[account(
        seeds = [POLICY_SEED, policy.holder.as_ref(), &policy.policy_id.to_le_bytes()],
        bump = policy.bump,
        constraint = policy.holder == holder.key() @ CovanticError::UnauthorizedHolder,
    )]
    pub policy: Box<Account<'info, InsurancePolicy>>,

    #[account(
        init_if_needed,
        payer = holder,
        space = GovernanceBaseline::LEN,
        seeds = [GOVERNANCE_BASELINE_SEED, policy.key().as_ref()],
        bump,
    )]
    pub baseline: Box<Account<'info, GovernanceBaseline>>,

    pub system_program: Program<'info, System>,
}
