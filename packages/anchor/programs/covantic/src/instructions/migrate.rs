use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::state::{InsuranceVault, StakerPosition, LOSS_INDEX_SCALE};

/// Grow an account written by the previous layout, and return whether it was
/// already large enough.
///
/// Both migrations below take `UncheckedAccount` rather than `Account<T>`, and
/// that is forced: `Account<T>` deserializes during `try_accounts`, and an
/// account written before `loss_index` existed is 16 bytes short — so it fails
/// before any constraint, including a `realloc`, could run. There is no way to
/// migrate such an account through a typed handle; the discriminator is
/// therefore checked by hand below, which is the one guarantee `Account<T>`
/// would otherwise have provided.
fn grow_to<'info>(
    account: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program_id: Pubkey,
    needed: usize,
    expected_discriminator: &[u8],
) -> Result<bool> {
    {
        let data = account.try_borrow_data()?;
        require!(data.len() >= 8, CovanticError::InvalidAccountForMigration);
        require!(
            data.get(..8) == Some(expected_discriminator),
            CovanticError::InvalidAccountForMigration
        );
    }

    if account.data_len() >= needed {
        return Ok(true);
    }

    // Top the account up to rent exemption at the new size before resizing;
    // a resize that leaves it rent-paying would be reaped.
    let minimum = Rent::get()?.minimum_balance(needed);
    let deficit = minimum.saturating_sub(account.lamports());
    if deficit > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program_id,
                system_program::Transfer {
                    from: payer.clone(),
                    to: account.clone(),
                },
            ),
            deficit,
        )?;
    }

    account.resize(needed)?;
    Ok(false)
}

/// One-time migration for a vault written before losses were socialised.
///
/// Idempotent: safe to call on an already-migrated vault, and safe to call
/// twice. It seeds `loss_index` only on an account it *just grew*, so it
/// cannot undo a real loss.
///
/// The distinction matters because zero is otherwise overloaded. A freshly
/// grown account reads zero because nothing has been written there; a vault
/// whose stakers were wiped out to the last unit used to read zero because
/// `absorb_loss` scaled the index to nothing. Seeding on `current == 0` could
/// not tell those apart, and restoring full scale on the second erased the
/// socialised loss from every position that had not been touched since —
/// `settle_losses` sees a matching snapshot and returns without revaluing.
/// `absorb_loss` now floors the index at 1, and this only writes when the
/// account was not already the right size.
pub fn migrate_vault_handler(ctx: Context<MigrateVault>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let needed = 8 + InsuranceVault::INIT_SPACE;

    let already_sized = grow_to(
        vault,
        &ctx.accounts.payer.to_account_info(),
        ctx.accounts.system_program.key(),
        needed,
        InsuranceVault::DISCRIMINATOR,
    )?;
    if already_sized {
        return Ok(());
    }

    // `loss_index` is the trailing 16 bytes. A freshly grown account reads
    // zero there, which is not a valid index — every position would revalue
    // against it and a zero index can never recover. Seed it whole.
    let mut data = vault.try_borrow_mut_data()?;
    let start = needed
        .checked_sub(16)
        .ok_or(CovanticError::InvalidAccountForMigration)?;
    let slot = data
        .get_mut(start..needed)
        .ok_or(CovanticError::InvalidAccountForMigration)?;
    let current = u128::from_le_bytes(
        slot.try_into()
            .map_err(|_| error!(CovanticError::InvalidAccountForMigration))?,
    );
    if current == 0 {
        slot.copy_from_slice(&LOSS_INDEX_SCALE.to_le_bytes());
    }

    Ok(())
}

/// One-time migration for a staker position written before losses were
/// socialised. Permissionless: it only grows the account, and the trailing
/// zero is exactly the "not yet initialised" value `settle_losses` reads as
/// "adopt the current index", so no value needs writing.
pub fn migrate_staker_position_handler(ctx: Context<MigrateStakerPosition>) -> Result<()> {
    grow_to(
        &ctx.accounts.staker_position,
        &ctx.accounts.payer.to_account_info(),
        ctx.accounts.system_program.key(),
        8 + StakerPosition::INIT_SPACE,
        StakerPosition::DISCRIMINATOR,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: cannot be `Account<InsuranceVault>` — see `grow_to`. Pinned by
    /// PDA seeds, and its discriminator is verified before anything is written.
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateStakerPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: cannot be `Account<StakerPosition>` — see `grow_to`. Pinned by
    /// PDA seeds, and its discriminator is verified before it is resized.
    #[account(mut, seeds = [STAKER_SEED, staker.key().as_ref()], bump)]
    pub staker_position: UncheckedAccount<'info>,

    /// CHECK: only used to derive the position PDA above.
    pub staker: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
