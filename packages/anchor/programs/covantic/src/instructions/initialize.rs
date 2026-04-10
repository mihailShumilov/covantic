use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::state::{InsuranceVault, ProtocolConfig};

/// Initialize the protocol: creates config PDA, vault PDA, and vault token account.
/// Called ONCE at deployment.
pub fn initialize_handler(ctx: Context<Initialize>, oracle_authority: Pubkey) -> Result<()> {
    // Initialize ProtocolConfig
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle_authority = oracle_authority;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.policy_counter = 0;
    config.paused = false;
    config.premium_multiplier_bps = DEFAULT_PREMIUM_MULTIPLIER;
    config.bump = ctx.bumps.config;

    // Initialize InsuranceVault
    let vault_key = ctx.accounts.vault.key();
    let vault = &mut ctx.accounts.vault;
    vault.authority = vault_key;
    vault.total_staked = 0;
    vault.total_coverage = 0;
    vault.total_premiums_collected = 0;
    vault.total_claims_paid = 0;
    vault.staker_count = 0;
    vault.solvency_ratio = u16::MAX;
    vault.total_staker_rewards = 0;
    vault.reserve_fund = 0;
    vault.protocol_treasury = 0;
    vault.bump = ctx.bumps.vault;

    msg!("Covantic protocol initialized");
    msg!("Admin: {}", config.admin);
    msg!("Oracle: {}", oracle_authority);
    msg!("USDC Mint: {}", config.usdc_mint);

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Admin who initializes the protocol
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Protocol configuration PDA
    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// Insurance vault PDA
    #[account(
        init,
        payer = admin,
        space = 8 + InsuranceVault::INIT_SPACE,
        seeds = [VAULT_SEED],
        bump,
    )]
    pub vault: Account<'info, InsuranceVault>,

    /// USDC mint
    pub usdc_mint: Account<'info, Mint>,

    /// Vault USDC token account (ATA owned by vault PDA)
    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}
