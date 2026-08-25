use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::{AdminTransferCancelled, AdminTransferProposed, AdminTransferred};
use crate::state::{PendingAdminTransfer, ProtocolConfig};

/// Propose a new protocol admin. Step one of two.
///
/// The admin is the only key that can pause the protocol or rotate the oracle
/// authority. Setting it in a single step meant a mistyped pubkey took effect
/// at once and irreversibly: no pause, no oracle rotation, no recovery path in
/// the program, while the vault stayed live. So the handover is split — this
/// records a candidate, and nothing changes until that candidate signs.
///
/// Re-proposing overwrites any pending proposal. Every field is rewritten
/// below, so an overwrite carries nothing forward from the previous one.
pub fn propose_admin_handler(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    let config = &ctx.accounts.config;

    require!(
        ctx.accounts.admin.key() == config.admin,
        CovanticError::UnauthorizedAdmin
    );

    // The two candidates that make the two-step pointless.
    //
    // The default pubkey is unsignable, so accepting it is impossible and the
    // proposal would sit there forever — harmless but meaningless. Proposing
    // the incumbent is a no-op that still costs rent and muddies the record.
    require!(
        new_admin != Pubkey::default(),
        CovanticError::InvalidAdminCandidate
    );
    require!(
        new_admin != config.admin,
        CovanticError::InvalidAdminCandidate
    );

    let pending = &mut ctx.accounts.pending;
    pending.proposed_admin = new_admin;
    pending.proposed_by = ctx.accounts.admin.key();
    pending.proposed_at = Clock::get()?.unix_timestamp;
    pending.bump = ctx.bumps.pending;

    emit!(AdminTransferProposed {
        current_admin: config.admin,
        proposed_admin: new_admin,
        proposed_at: pending.proposed_at,
    });

    Ok(())
}

/// Accept the admin role. Step two of two.
///
/// Signed by the candidate, which is the whole point: a key that cannot sign
/// cannot become admin, so a typo is caught before control moves rather than
/// after.
pub fn accept_admin_handler(ctx: Context<AcceptAdmin>) -> Result<()> {
    let pending = &ctx.accounts.pending;

    require!(
        ctx.accounts.new_admin.key() == pending.proposed_admin,
        CovanticError::NotProposedAdmin
    );

    let config = &mut ctx.accounts.config;
    let previous_admin = config.admin;
    config.admin = pending.proposed_admin;

    emit!(AdminTransferred {
        previous_admin,
        new_admin: config.admin,
        accepted_at: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

/// Withdraw a pending proposal. Rent returns to the admin that opened it.
pub fn cancel_admin_transfer_handler(ctx: Context<CancelAdminTransfer>) -> Result<()> {
    require!(
        ctx.accounts.admin.key() == ctx.accounts.config.admin,
        CovanticError::UnauthorizedAdmin
    );

    emit!(AdminTransferCancelled {
        admin: ctx.accounts.admin.key(),
        proposed_admin: ctx.accounts.pending.proposed_admin,
        cancelled_at: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.admin == admin.key() @ CovanticError::UnauthorizedAdmin,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// `init_if_needed` so the admin can replace a proposal without a separate
    /// cancel. Safe here in a way it is not on the checkpoint accounts: this
    /// holds no running total and no previous value, and the handler rewrites
    /// every field, so nothing survives an overwrite.
    #[account(
        init_if_needed,
        payer = admin,
        space = PendingAdminTransfer::LEN,
        seeds = [PENDING_ADMIN_SEED],
        bump,
    )]
    pub pending: Account<'info, PendingAdminTransfer>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// The proposed admin. Must sign — that signature is the guarantee the
    /// key exists and is controlled.
    #[account(mut)]
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// Closed on success, refunding rent to the admin that opened the
    /// proposal rather than to whoever happens to accept it.
    #[account(
        mut,
        seeds = [PENDING_ADMIN_SEED],
        bump = pending.bump,
        constraint = pending.proposed_admin == new_admin.key() @ CovanticError::NotProposedAdmin,
        close = rent_refund,
    )]
    pub pending: Account<'info, PendingAdminTransfer>,

    /// CHECK: not read or written — it only receives the closed account's
    /// rent, and the constraint pins it to the recorded proposer.
    #[account(
        mut,
        constraint = rent_refund.key() == pending.proposed_by @ CovanticError::InvalidRentRefund,
    )]
    pub rent_refund: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelAdminTransfer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.admin == admin.key() @ CovanticError::UnauthorizedAdmin,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [PENDING_ADMIN_SEED],
        bump = pending.bump,
        close = admin,
    )]
    pub pending: Account<'info, PendingAdminTransfer>,
}
