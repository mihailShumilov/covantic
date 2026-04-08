use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::AgentGuardError;
use crate::events::PolicyCreated;
use crate::state::{InsurancePolicy, InsuranceVault, ProtocolConfig};

/// Create a new insurance policy.
/// Holder pays premium in USDC which is transferred to the vault.
pub fn handler(
    ctx: Context<CreatePolicy>,
    coverage_amount: u64,
    duration_seconds: i64,
    risk_tier: u8,
    agent_address: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let vault = &mut ctx.accounts.vault;

    // Validate protocol is not paused
    require!(!config.paused, AgentGuardError::ProtocolPaused);

    // Validate coverage amount
    require!(
        coverage_amount >= MIN_COVERAGE_AMOUNT,
        AgentGuardError::CoverageTooLow
    );
    require!(
        coverage_amount <= MAX_COVERAGE_AMOUNT,
        AgentGuardError::CoverageTooHigh
    );

    // Validate duration
    require!(
        duration_seconds >= MIN_POLICY_DURATION,
        AgentGuardError::DurationTooShort
    );
    require!(
        duration_seconds <= MAX_POLICY_DURATION,
        AgentGuardError::DurationTooLong
    );

    // Validate risk tier
    require!(
        risk_tier <= RISK_TIER_HIGH,
        AgentGuardError::InvalidRiskTier
    );

    // Check solvency allows this risk tier
    if risk_tier == RISK_TIER_HIGH && vault.solvency_ratio < SOLVENCY_CAUTION {
        return Err(AgentGuardError::SolvencyTooLow.into());
    }
    if vault.solvency_ratio < SOLVENCY_CRITICAL && vault.total_coverage > 0 {
        return Err(AgentGuardError::SolvencyTooLow.into());
    }

    // Calculate premium
    let premium_bps = match risk_tier {
        RISK_TIER_LOW => PREMIUM_BPS_LOW,
        RISK_TIER_MEDIUM => PREMIUM_BPS_MEDIUM,
        RISK_TIER_HIGH => PREMIUM_BPS_HIGH,
        _ => return Err(AgentGuardError::InvalidRiskTier.into()),
    };

    let annual_premium = (coverage_amount as u128)
        .checked_mul(premium_bps as u128)
        .ok_or(AgentGuardError::MathOverflow)?
        .checked_div(10000)
        .ok_or(AgentGuardError::MathOverflow)?;

    let premium = (annual_premium)
        .checked_mul(duration_seconds as u128)
        .ok_or(AgentGuardError::MathOverflow)?
        .checked_div(SECONDS_PER_YEAR as u128)
        .ok_or(AgentGuardError::MathOverflow)?;

    // Apply premium multiplier (solvency-based)
    let premium = premium
        .checked_mul(config.premium_multiplier_bps as u128)
        .ok_or(AgentGuardError::MathOverflow)?
        .checked_div(10000)
        .ok_or(AgentGuardError::MathOverflow)?;

    // Enforce minimum premium
    let premium = premium.max(MIN_PREMIUM as u128) as u64;

    // Transfer USDC from holder to vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.holder_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.holder.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, premium)?;

    // Distribute premium: 70% stakers, 20% reserve, 10% protocol
    let staker_share = (premium as u128)
        .checked_mul(STAKER_SHARE_BPS as u128)
        .ok_or(AgentGuardError::MathOverflow)?
        .checked_div(10000)
        .ok_or(AgentGuardError::MathOverflow)? as u64;
    let reserve_share = (premium as u128)
        .checked_mul(RESERVE_SHARE_BPS as u128)
        .ok_or(AgentGuardError::MathOverflow)?
        .checked_div(10000)
        .ok_or(AgentGuardError::MathOverflow)? as u64;
    let protocol_share = premium
        .checked_sub(staker_share)
        .and_then(|v| v.checked_sub(reserve_share))
        .ok_or(AgentGuardError::MathOverflow)?;

    vault.total_staker_rewards = vault
        .total_staker_rewards
        .checked_add(staker_share)
        .ok_or(AgentGuardError::MathOverflow)?;
    vault.reserve_fund = vault
        .reserve_fund
        .checked_add(reserve_share)
        .ok_or(AgentGuardError::MathOverflow)?;
    vault.protocol_treasury = vault
        .protocol_treasury
        .checked_add(protocol_share)
        .ok_or(AgentGuardError::MathOverflow)?;

    // Update vault totals
    vault.total_coverage = vault
        .total_coverage
        .checked_add(coverage_amount)
        .ok_or(AgentGuardError::MathOverflow)?;
    vault.total_premiums_collected = vault
        .total_premiums_collected
        .checked_add(premium)
        .ok_or(AgentGuardError::MathOverflow)?;
    vault.recalculate_solvency();

    // Create policy
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let policy_id = config.policy_counter;
    config.policy_counter = config
        .policy_counter
        .checked_add(1)
        .ok_or(AgentGuardError::MathOverflow)?;

    let policy = &mut ctx.accounts.policy;
    policy.policy_id = policy_id;
    policy.holder = ctx.accounts.holder.key();
    policy.agent_address = agent_address;
    policy.coverage_amount = coverage_amount;
    policy.premium_paid = premium;
    policy.risk_tier = risk_tier;
    policy.start_time = now;
    policy.expiry_time = now
        .checked_add(duration_seconds)
        .ok_or(AgentGuardError::MathOverflow)?;
    policy.claim_submitted_at = 0;
    policy.state = InsurancePolicy::STATE_ACTIVE;
    policy.trigger_type = TRIGGER_NONE;
    policy.trigger_tx_signature = vec![];
    policy.payout_amount = 0;
    policy.bump = ctx.bumps.policy;

    emit!(PolicyCreated {
        policy_id,
        holder: policy.holder,
        agent_address,
        coverage_amount,
        premium_paid: premium,
        risk_tier,
        start_time: now,
        expiry_time: policy.expiry_time,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(coverage_amount: u64, duration_seconds: i64, risk_tier: u8, agent_address: Pubkey)]
pub struct CreatePolicy<'info> {
    /// Policy holder (signer and payer)
    #[account(mut)]
    pub holder: Signer<'info>,

    /// Protocol config (for policy_counter and multiplier)
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// Insurance vault
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, InsuranceVault>,

    /// New policy PDA
    #[account(
        init,
        payer = holder,
        space = 8 + InsurancePolicy::INIT_SPACE,
        seeds = [POLICY_SEED, holder.key().as_ref(), &config.policy_counter.to_le_bytes()],
        bump,
    )]
    pub policy: Account<'info, InsurancePolicy>,

    /// Holder's USDC token account
    #[account(
        mut,
        constraint = holder_token_account.owner == holder.key(),
        constraint = holder_token_account.mint == config.usdc_mint,
    )]
    pub holder_token_account: Account<'info, TokenAccount>,

    /// Vault's USDC token account
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key(),
        constraint = vault_token_account.mint == config.usdc_mint,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
