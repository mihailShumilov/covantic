use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::BalanceCheckpointed;
use crate::state::{InsurancePolicy, PolicyBalanceCheckpoint, ProtocolConfig};

/// Record what the covered account holds, right now, as read by this program.
///
/// Permissionless on purpose. The checkpoint is the baseline a later payout
/// is bounded by, and a baseline only the oracle could write would put the
/// oracle back in charge of the number the bound is supposed to constrain.
/// Anyone may call this; nobody can influence what it records.
///
/// The account read is not passed as an opaque pubkey to be trusted. The
/// `associated_token` constraints below make Anchor derive it from the
/// policy's own `agent_address` and the config's USDC mint and check that the
/// supplied account is that one. A caller cannot point this at a different
/// account, and so cannot manufacture a baseline.
///
/// Fresh checkpoints overwrite stale ones, and the reading being replaced is
/// kept in `prev_*`. That matters for a case that would otherwise be a hole:
/// a crank tick landing *after* a drain would otherwise overwrite the only
/// pre-incident baseline with a post-incident one, and the payout path would
/// find nothing to measure against.
pub fn checkpoint_balance_handler(ctx: Context<CheckpointBalance>) -> Result<()> {
    let clock = Clock::get()?;
    let policy = &ctx.accounts.policy;
    let covered = &ctx.accounts.covered_token_account;

    // Expired and settled policies have nothing left to protect, and writing
    // checkpoints for them is rent spent on noise.
    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE
            || policy.state == InsurancePolicy::STATE_CLAIM_PENDING,
        CovanticError::PolicyNotActive
    );

    let checkpoint = &mut ctx.accounts.checkpoint;
    let is_new = checkpoint.policy_id == 0 && checkpoint.slot == 0;

    // `prev_*` is a pre-drop watermark, not simply "the previous reading".
    //
    // Shifting history by one slot on every tick looked right and was not: the
    // crank runs every couple of minutes, a claim is only filed once off-chain
    // verification finishes, so at least one tick reliably lands *between* the
    // incident and the claim. That tick's post-drain reading became
    // `checkpoint.amount`, the next one pushed the last pre-incident reading
    // out of `prev_amount` entirely, and `verify_and_payout_exploit` was left
    // subtracting a drained balance from a drained balance — `observed_drop`
    // of zero on a real theft, reverting, recorded `failed`.
    //
    // So a drop pins the reading that preceded it, and later ticks do not
    // dislodge the pin until it ages past the window a payout could use it in
    // anyway. Everything here is still a balance the program read for itself;
    // nothing is accepted from the caller.
    let dropped = !is_new && covered.amount < checkpoint.amount;
    let pin_held = !is_new && checkpoint.prev_amount > checkpoint.amount;
    let pin_expired = !is_new
        && clock
            .unix_timestamp
            .saturating_sub(checkpoint.prev_unix_timestamp)
            > MAX_CHECKPOINT_AGE;

    let (prev_amount, prev_slot, prev_unix_timestamp) = if is_new {
        (covered.amount, clock.slot, clock.unix_timestamp)
    } else if dropped {
        // Pin the reading immediately before the drop.
        (
            checkpoint.amount,
            checkpoint.slot,
            checkpoint.unix_timestamp,
        )
    } else if pin_held && !pin_expired {
        // Hold the existing pin rather than overwriting it with a reading
        // taken after the money already left.
        (
            checkpoint.prev_amount,
            checkpoint.prev_slot,
            checkpoint.prev_unix_timestamp,
        )
    } else {
        (
            checkpoint.amount,
            checkpoint.slot,
            checkpoint.unix_timestamp,
        )
    };

    checkpoint.policy_id = policy.policy_id;
    checkpoint.covered_account = covered.key();
    checkpoint.prev_amount = prev_amount;
    checkpoint.prev_slot = prev_slot;
    checkpoint.prev_unix_timestamp = prev_unix_timestamp;
    checkpoint.amount = covered.amount;
    checkpoint.slot = clock.slot;
    checkpoint.unix_timestamp = clock.unix_timestamp;
    checkpoint.bump = ctx.bumps.checkpoint;

    emit!(BalanceCheckpointed {
        policy_id: policy.policy_id,
        covered_account: covered.key(),
        amount: checkpoint.amount,
        prev_amount: checkpoint.prev_amount,
        slot: checkpoint.slot,
        unix_timestamp: checkpoint.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CheckpointBalance<'info> {
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

    /// The covered account, derived rather than accepted.
    ///
    /// These two constraints are what make the whole mechanism trustworthy.
    /// Anchor recomputes the associated token address from the policy's agent
    /// and the protocol's USDC mint and rejects anything else, so the balance
    /// recorded below is unambiguously the covered agent's.
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = policy.agent_address,
    )]
    pub covered_token_account: Box<Account<'info, TokenAccount>>,

    #[account(constraint = usdc_mint.key() == config.usdc_mint @ CovanticError::InvalidTokenAccount)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = cranker,
        space = PolicyBalanceCheckpoint::LEN,
        seeds = [CHECKPOINT_SEED, policy.key().as_ref()],
        bump,
    )]
    pub checkpoint: Box<Account<'info, PolicyBalanceCheckpoint>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
