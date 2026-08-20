use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::AuthorityCheckpointed;
use crate::state::{InsurancePolicy, PolicyAuthorityCheckpoint, ProtocolConfig};

/// Record who controls the covered account, right now, as read by this
/// program.
///
/// Permissionless, on the same reasoning as `checkpoint_balance`: a record
/// only the oracle could write would put the oracle back in charge of the
/// facts that are supposed to constrain it. Anyone may call this; nobody can
/// influence what it records.
///
/// **Why this cannot reuse `associated_token::authority`, which is the
/// obvious thing to write and is wrong.** `checkpoint_balance` derives the
/// covered account with:
///
/// ```ignore
/// #[account(
///     associated_token::mint = usdc_mint,
///     associated_token::authority = policy.agent_address,
/// )]
/// ```
///
/// Anchor compiles that into, among other checks, `if token_account.owner !=
/// agent { return Err(ConstraintTokenOwner) }`. That is exactly right for a
/// balance reading and exactly fatal here: the event this instruction exists
/// to observe is *the owner no longer being the agent*. Once a seizure lands,
/// that constraint fails and the account cannot be loaded at all — which is
/// also why the exploit settlement path silently cannot settle a seizure, and
/// why this trigger needs its own.
///
/// So the address is derived and compared directly. The caller still cannot
/// point the reading anywhere — `get_associated_token_address` is computed
/// from the policy's own agent and the config's mint — but the `owner` field
/// is allowed to have changed, which is the whole point.
pub fn checkpoint_authority_handler(ctx: Context<CheckpointAuthority>) -> Result<()> {
    let clock = Clock::get()?;
    let policy = &ctx.accounts.policy;
    let covered = &ctx.accounts.covered_token_account;

    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE
            || policy.state == InsurancePolicy::STATE_CLAIM_PENDING,
        CovanticError::PolicyNotActive
    );

    let checkpoint = &mut ctx.accounts.checkpoint;
    let is_new = checkpoint.policy_id == 0 && checkpoint.slot == 0;

    let observed_owner = covered.owner;
    let observed_delegate: Option<Pubkey> = covered.delegate.into();
    let observed_close_authority: Option<Pubkey> = covered.close_authority.into();
    let observed_frozen = covered.is_frozen();

    let prev_owner = if is_new { observed_owner } else { checkpoint.owner };
    let prev_delegate = if is_new { observed_delegate } else { checkpoint.delegate };
    let prev_frozen = if is_new { observed_frozen } else { checkpoint.frozen };
    let prev_amount = if is_new { covered.amount } else { checkpoint.amount };
    let prev_slot = if is_new { clock.slot } else { checkpoint.slot };
    let prev_unix_timestamp = if is_new {
        clock.unix_timestamp
    } else {
        checkpoint.unix_timestamp
    };

    checkpoint.policy_id = policy.policy_id;
    checkpoint.covered_account = covered.key();
    checkpoint.owner = observed_owner;
    checkpoint.delegate = observed_delegate;
    checkpoint.delegated_amount = covered.delegated_amount;
    checkpoint.close_authority = observed_close_authority;
    checkpoint.frozen = observed_frozen;
    checkpoint.amount = covered.amount;
    checkpoint.slot = clock.slot;
    checkpoint.unix_timestamp = clock.unix_timestamp;

    checkpoint.prev_owner = prev_owner;
    checkpoint.prev_delegate = prev_delegate;
    checkpoint.prev_frozen = prev_frozen;
    checkpoint.prev_amount = prev_amount;
    checkpoint.prev_slot = prev_slot;
    checkpoint.prev_unix_timestamp = prev_unix_timestamp;
    checkpoint.bump = ctx.bumps.checkpoint;

    emit!(AuthorityCheckpointed {
        policy_id: checkpoint.policy_id,
        covered_account: checkpoint.covered_account,
        owner: checkpoint.owner,
        prev_owner: checkpoint.prev_owner,
        frozen: checkpoint.frozen,
        amount: checkpoint.amount,
        slot: checkpoint.slot,
        unix_timestamp: checkpoint.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CheckpointAuthority<'info> {
    /// Anyone. Pays rent the first time only.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [POLICY_SEED, policy.holder.as_ref(), &policy.policy_id.to_le_bytes()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, InsurancePolicy>>,

    /// The covered account, derived by address rather than by ownership.
    ///
    /// See the handler's note: an ownership constraint would reject exactly
    /// the account state this instruction exists to record.
    #[account(
        address = get_associated_token_address(&policy.agent_address, &usdc_mint.key())
            @ CovanticError::InvalidCoveredAccount,
    )]
    pub covered_token_account: Box<Account<'info, TokenAccount>>,

    #[account(constraint = usdc_mint.key() == config.usdc_mint @ CovanticError::InvalidTokenAccount)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = cranker,
        space = PolicyAuthorityCheckpoint::LEN,
        seeds = [AUTHORITY_CHECKPOINT_SEED, policy.key().as_ref()],
        bump,
    )]
    pub checkpoint: Box<Account<'info, PolicyAuthorityCheckpoint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
