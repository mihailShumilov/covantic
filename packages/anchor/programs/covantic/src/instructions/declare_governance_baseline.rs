use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::GovernanceBaselineDeclared;
use crate::instructions::checkpoint_authority::observe;
use crate::state::{BaselineView, GovernanceBaseline, InsurancePolicy, ProtocolConfig};

/// What the holder commits to about who may control their agent.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GovernanceManifest {
    /// Expected owner of the covered token account. Normally the agent.
    pub token_owner: Pubkey,
    pub expected_delegate: Option<Pubkey>,
    pub expected_close_authority: Option<Pubkey>,
    /// Must be `None`. See `GovernanceBaseline::program_upgrade_authority`.
    pub program_upgrade_authority: Option<Pubkey>,
    /// Must be `None`. See `GovernanceBaseline::controller`.
    pub controller: Option<Pubkey>,
    /// Must be zero.
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
/// Three rules make the statement worth anything:
///
/// **It matures on a delay.** `effective_at` is `GOVERNANCE_BASELINE_DELAY`
/// in the future, and `verify_and_payout_governance` refuses a baseline that
/// had not matured before the pre-incident reading it settles against.
/// Without that, a stolen holder key would declare a convenient set and claim
/// against it in the next instruction. With it, a fraudulent claim has to be
/// set up on chain, in public, an hour ahead.
///
/// **It is bound to the account as it stands.** The covered account is read
/// here, and the declaration is refused unless its current owner, delegate
/// and close authority are all inside the set being declared, and the account
/// is not frozen. A holder who has already handed the account to an outside
/// key cannot then describe the agent as its rightful owner and, an hour
/// later, present the pre-existing arrangement as a takeover.
///
/// **The previous declaration is retained whole.** A refresh keeps every
/// role, wildcard, hash and timestamp of the declaration it replaces, so a
/// rotation landing between the takeover and the claim cannot erase the only
/// usable "before" — the same hole `PolicyBalanceCheckpoint.prev_*` closes.
///
/// What the program does *not* do is interpret `manifest_hash`. It cannot
/// decode a Squads config or an allowed-signer list, and pretending it could
/// would be worse than committing to the hash and leaving the richer check to
/// a reader who can perform it. For the same reason it refuses a manifest
/// that names a program upgrade authority or a controller: the checkpoint
/// reads a token account and can observe neither, so accepting them would
/// sell coverage the settlement path has no way to adjudicate.
pub fn declare_governance_baseline_handler(
    ctx: Context<DeclareGovernanceBaseline>,
    manifest: GovernanceManifest,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let policy = &ctx.accounts.policy;

    policy.assert_readable()?;
    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE,
        CovanticError::PolicyNotActive
    );
    require!(
        manifest.token_owner != Pubkey::default(),
        CovanticError::InvalidGovernanceBaseline
    );
    // Roles the program cannot observe are refused rather than recorded. A
    // baseline that lists them reads, to a holder, as coverage; on chain it
    // is a field nothing ever compares.
    require!(
        manifest.program_upgrade_authority.is_none()
            && manifest.controller.is_none()
            && manifest.controller_min_threshold == 0,
        CovanticError::UnsupportedGovernanceRole
    );
    // `None` is how an optional role says "nobody". `Some(zero)` is malformed
    // state that a default-keyed candidate would match against.
    require!(
        manifest.expected_delegate != Some(Pubkey::default())
            && manifest.expected_close_authority != Some(Pubkey::default()),
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

    let mut extra_authorities = [Pubkey::default(); MAX_GOVERNANCE_EXTRA_AUTHORITIES];
    for (slot, key) in manifest.extra_authorities.iter().enumerate() {
        extra_authorities[slot] = *key;
    }
    let extra_authority_count = manifest.extra_authorities.len() as u8;

    // Bind the declaration to the account it describes. What is declared
    // has to be true *now*; a declaration that describes a state the account
    // is not in is not a baseline, it is a story.
    let declared = BaselineView {
        token_owner: manifest.token_owner,
        expected_delegate: manifest.expected_delegate,
        expected_close_authority: manifest.expected_close_authority,
        extra_authorities,
        extra_authority_count,
        manifest_hash: manifest.manifest_hash,
        declared_at: now,
        effective_at: 0,
    };
    let reading = observe(&ctx.accounts.covered_token_account, &clock);
    require!(
        declared.covers(&reading, &policy.holder, &policy.agent_address),
        CovanticError::GovernanceBaselineNotBoundToAccount
    );

    let baseline = &mut ctx.accounts.baseline;
    let is_new = baseline.policy_id == 0 && baseline.effective_at == 0;

    // A first declaration has no predecessor, and must say so. Seeding `prev_*`
    // with this declaration's own values and `now` is the natural thing to
    // write and exactly wrong: any `prev`-based fallback would then accept the
    // declaration as matured the instant it was written, silently disabling
    // the whole maturity delay.
    if is_new {
        baseline.clear_predecessor();
    } else {
        baseline.retain_as_predecessor();
    }

    baseline.policy_id = policy.policy_id;
    baseline.holder = policy.holder;
    baseline.token_owner = manifest.token_owner;
    baseline.expected_delegate = manifest.expected_delegate;
    baseline.expected_close_authority = manifest.expected_close_authority;
    baseline.program_upgrade_authority = None;
    baseline.controller = None;
    baseline.controller_min_threshold = 0;
    baseline.extra_authorities = extra_authorities;
    baseline.extra_authority_count = extra_authority_count;
    baseline.manifest_hash = manifest.manifest_hash;
    baseline.declared_at = now;
    baseline.effective_at = now
        .checked_add(GOVERNANCE_BASELINE_DELAY)
        .ok_or(CovanticError::MathOverflow)?;
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

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [POLICY_SEED, policy.holder.as_ref(), &policy.policy_id.to_le_bytes()],
        bump = policy.bump,
        constraint = policy.holder == holder.key() @ CovanticError::UnauthorizedHolder,
    )]
    pub policy: Box<Account<'info, InsurancePolicy>>,

    /// The covered account the declaration is checked against, derived by
    /// address for the reason `checkpoint_authority` gives: a declaration may
    /// legitimately name an operator as the owner, and an ownership
    /// constraint would refuse to load the account in exactly that case.
    #[account(
        address = get_associated_token_address(&policy.agent_address, &usdc_mint.key())
            @ CovanticError::InvalidCoveredAccount,
    )]
    pub covered_token_account: Box<Account<'info, TokenAccount>>,

    #[account(constraint = usdc_mint.key() == config.usdc_mint @ CovanticError::InvalidTokenAccount)]
    pub usdc_mint: Box<Account<'info, Mint>>,

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
