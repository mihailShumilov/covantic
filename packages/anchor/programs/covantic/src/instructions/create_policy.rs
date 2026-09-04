use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::PolicyCreated;
use crate::instructions::declare_agent_mandate::{
    validate_mandate, write_mandate, AgentMandate, MandateMaturity,
};
use crate::state::{
    InsurancePolicy, InsuranceVault, PolicyAgentMandate, PolicyBalanceCheckpoint, ProtocolConfig,
    RiskAttestation,
};

/// Create a new insurance policy.
///
/// The risk tier is **not** a caller-supplied argument — it's read from the
/// oracle-signed `RiskAttestation` PDA for the target agent. This closes the
/// adverse-selection hole where buyers could pick LOW for a known-HIGH agent.
/// The holder pays premium in USDC which is transferred to the vault.
///
/// **The deductible is declared here, for the same reason.** The tier stopped
/// a buyer choosing a cheaper risk class than their agent deserved. It did not
/// stop them buying at any tier and *then* authoring an operating envelope
/// narrow enough that a breach was certain — a 100 USDC cap for an agent
/// holding 5,000, a 600 USDC movement to an address the verifier has no way to
/// know they control, and the 500 overshoot collected against a premium quoted
/// before any of it was chosen.
///
/// So the envelope arrives with the purchase, the oracle commits to its hash
/// in the attestation it signs, and this instruction refuses a mismatch. The
/// premium is then quoted against the deductible it actually buys, which is
/// what an underwriter does and what this was missing.
pub fn create_policy_handler(
    ctx: Context<CreatePolicy>,
    coverage_amount: u64,
    duration_seconds: i64,
    agent_address: Pubkey,
    mandate: AgentMandate,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let vault = &mut ctx.accounts.vault;
    let attestation = &ctx.accounts.attestation;

    // Validate protocol is not paused
    require!(!config.paused, CovanticError::ProtocolPaused);

    // Validate coverage amount
    require!(
        coverage_amount >= MIN_COVERAGE_AMOUNT,
        CovanticError::CoverageTooLow
    );
    require!(
        coverage_amount <= MAX_COVERAGE_AMOUNT,
        CovanticError::CoverageTooHigh
    );

    // Validate duration
    require!(
        duration_seconds >= MIN_POLICY_DURATION,
        CovanticError::DurationTooShort
    );
    require!(
        duration_seconds <= MAX_POLICY_DURATION,
        CovanticError::DurationTooLong
    );

    // Enforce attestation freshness. The PDA seeds already bind the
    // attestation to `agent_address`, but we still assert the stored field
    // matches as defense-in-depth against future seed changes.
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    require!(
        attestation.agent == agent_address,
        CovanticError::AttestationAgentMismatch
    );
    require!(
        now <= attestation.expires_at,
        CovanticError::AttestationExpired
    );

    // Tier comes from the oracle. No caller input, no self-selection.
    let risk_tier = attestation.tier;
    require!(
        risk_tier <= RISK_TIER_HIGH,
        CovanticError::InvalidRiskTier
    );

    // Check solvency allows this risk tier
    if risk_tier == RISK_TIER_HIGH && vault.solvency_ratio < SOLVENCY_CAUTION {
        return Err(CovanticError::SolvencyTooLow.into());
    }
    if vault.solvency_ratio < SOLVENCY_CRITICAL && vault.total_coverage > 0 {
        return Err(CovanticError::SolvencyTooLow.into());
    }

    // The envelope the oracle priced must be the envelope being declared.
    //
    // Without this the commitment is decoration: a client could quote a
    // generous envelope, get a cheap attestation, and pass a narrow one here.
    validate_mandate(&mandate, ctx.accounts.covered_token_account.amount)?;
    require!(
        attestation.mandate_hash == mandate.commitment(),
        CovanticError::AttestationMandateMismatch
    );

    // Calculate premium
    let premium_bps = match risk_tier {
        RISK_TIER_LOW => PREMIUM_BPS_LOW,
        RISK_TIER_MEDIUM => PREMIUM_BPS_MEDIUM,
        RISK_TIER_HIGH => PREMIUM_BPS_HIGH,
        _ => return Err(CovanticError::InvalidRiskTier.into()),
    };

    let annual_premium = (coverage_amount as u128)
        .checked_mul(premium_bps as u128)
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(10000)
        .ok_or(CovanticError::MathOverflow)?;

    let tier_premium = (annual_premium)
        .checked_mul(duration_seconds as u128)
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(SECONDS_PER_YEAR as u128)
        .ok_or(CovanticError::MathOverflow)?;

    // The deductible's own price, and it is **not** scaled by duration.
    //
    // What the envelope costs is the amount its holder can extract at will,
    // and that ability exists from the first minute of the policy rather than
    // accruing over its life. Charged as an annual rate it dissolved into the
    // tenor: a one-hour policy cost a fraction of a percent of what it let the
    // holder take, and no duration this program allows was long enough to
    // close the gap — break-even sat at 356 days against a 30-day maximum.
    //
    // Bounded by the coverage, because the extractable amount is: the policy
    // cannot pay more than it covers. The bound also stops a compromised
    // oracle key pricing coverage out of existence instead of declining to
    // attest, which is much harder to notice.
    require!(
        attestation.envelope_flat_premium <= coverage_amount,
        CovanticError::InvalidRiskTier
    );

    let premium = tier_premium
        .checked_add(attestation.envelope_flat_premium as u128)
        .ok_or(CovanticError::MathOverflow)?;

    // Apply premium multiplier (solvency-based)
    let premium = premium
        .checked_mul(config.premium_multiplier_bps as u128)
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(10000)
        .ok_or(CovanticError::MathOverflow)?;

    // Enforce minimum premium
    let premium = premium.max(MIN_PREMIUM as u128) as u64;

    // Transfer USDC from holder to vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.key(),
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
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(10000)
        .ok_or(CovanticError::MathOverflow)? as u64;
    let reserve_share = (premium as u128)
        .checked_mul(RESERVE_SHARE_BPS as u128)
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(10000)
        .ok_or(CovanticError::MathOverflow)? as u64;
    let protocol_share = premium
        .checked_sub(staker_share)
        .and_then(|v| v.checked_sub(reserve_share))
        .ok_or(CovanticError::MathOverflow)?;

    // Accrue the staker share through the reward-per-stake accumulator so
    // existing stakers earn proportionally; total_staker_rewards is also
    // incremented inside this helper.
    vault.accrue_staker_rewards(staker_share)?;

    vault.reserve_fund = vault
        .reserve_fund
        .checked_add(reserve_share)
        .ok_or(CovanticError::MathOverflow)?;
    vault.protocol_treasury = vault
        .protocol_treasury
        .checked_add(protocol_share)
        .ok_or(CovanticError::MathOverflow)?;

    // Update vault totals
    vault.total_coverage = vault
        .total_coverage
        .checked_add(coverage_amount)
        .ok_or(CovanticError::MathOverflow)?;
    vault.total_premiums_collected = vault
        .total_premiums_collected
        .checked_add(premium)
        .ok_or(CovanticError::MathOverflow)?;
    vault.recalculate_solvency();

    // Create policy
    let policy_id = config.policy_counter;
    config.policy_counter = config
        .policy_counter
        .checked_add(1)
        .ok_or(CovanticError::MathOverflow)?;

    let policy = &mut ctx.accounts.policy;
    policy.version = InsurancePolicy::CURRENT_VERSION;
    policy.policy_id = policy_id;
    policy.holder = ctx.accounts.holder.key();
    policy.agent_address = agent_address;
    policy.coverage_amount = coverage_amount;
    policy.premium_paid = premium;
    policy.risk_tier = risk_tier;
    policy.start_time = now;
    policy.expiry_time = now
        .checked_add(duration_seconds)
        .ok_or(CovanticError::MathOverflow)?;
    policy.claim_submitted_at = 0;
    policy.state = InsurancePolicy::STATE_ACTIVE;
    policy.trigger_type = TRIGGER_NONE;
    policy.trigger_tx_signature = vec![];
    policy.payout_amount = 0;
    policy.bump = ctx.bumps.policy;
    // Written by the purchase, and usable from this instant.
    //
    // The premium just paid is the price of this envelope and no other — the
    // hash in the oracle's attestation is compared above — and because the
    // oracle derived it from history that predates the quote, there is nothing
    // here the holder chose and nothing to backdate. See `MandateMaturity`.
    //
    // This is what lets cover be bought immediately before the transaction it
    // is meant to cover, which is the only shape an agent platform can offer.
    let mandate_bump = ctx.bumps.mandate;
    let holder_key = ctx.accounts.holder.key();
    write_mandate(
        &mut ctx.accounts.mandate,
        &mandate,
        policy_id,
        holder_key,
        now,
        mandate_bump,
        MandateMaturity::Immediate,
    )?;

    // The first balance reading, and it is a reading rather than a claim: the
    // amount comes from the covered account this instruction already loaded,
    // derived by Anchor from `agent_address`, never accepted from the caller.
    //
    // `prev_*` is set to the same reading rather than to zero. It is the
    // pre-drop watermark every payout subtracts from, and a zero there would
    // measure the first movement as a loss of everything the agent holds.
    // `checkpoint_balance` does exactly this for a checkpoint it creates; the
    // difference is only that the purchase no longer waits for it.
    let checkpoint = &mut ctx.accounts.checkpoint;
    let covered_amount = ctx.accounts.covered_token_account.amount;
    checkpoint.policy_id = policy_id;
    checkpoint.covered_account = ctx.accounts.covered_token_account.key();
    checkpoint.prev_amount = covered_amount;
    checkpoint.prev_slot = clock.slot;
    checkpoint.prev_unix_timestamp = now;
    checkpoint.amount = covered_amount;
    checkpoint.slot = clock.slot;
    checkpoint.unix_timestamp = now;
    checkpoint.bump = ctx.bumps.checkpoint;


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
#[instruction(coverage_amount: u64, duration_seconds: i64, agent_address: Pubkey)]
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
    pub config: Box<Account<'info, ProtocolConfig>>,

    /// Insurance vault
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, InsuranceVault>>,

    /// Oracle-signed risk attestation — tier comes from this account, not
    /// from caller input. PDA seeds bind it to `agent_address`.
    #[account(
        seeds = [ATTESTATION_SEED, agent_address.as_ref()],
        bump = attestation.bump,
    )]
    pub attestation: Box<Account<'info, RiskAttestation>>,

    /// New policy PDA
    #[account(
        init,
        payer = holder,
        space = 8 + InsurancePolicy::INIT_SPACE,
        seeds = [POLICY_SEED, holder.key().as_ref(), &config.policy_counter.to_le_bytes()],
        bump,
    )]
    pub policy: Box<Account<'info, InsurancePolicy>>,

    /// The envelope, created with the policy it was priced for.
    ///
    /// Boxed: `CreatePolicy` already carries the config, vault, attestation and
    /// two token accounts, and `PolicyAgentMandate` holds sixteen pubkeys.
    /// Unboxed it overflows the BPF stack frame in `try_accounts`, which
    /// `anchor build --no-idl` catches and `cargo check` does not.
    #[account(
        init,
        payer = holder,
        space = PolicyAgentMandate::LEN,
        seeds = [AGENT_MANDATE_SEED, policy.key().as_ref()],
        bump,
    )]
    pub mandate: Box<Account<'info, PolicyAgentMandate>>,

    /// The first balance reading, taken by the purchase itself.
    ///
    /// Every payout proves its loss by comparing the covered account against a
    /// checkpoint, and the checkpoint has to predate the movement. Writing the
    /// first one here is what lets cover be bought immediately before the
    /// transaction it is meant to cover: without it the baseline arrives on
    /// the sweep's own schedule, and a loss inside that window measures a drop
    /// of zero — the claim verifies, computes the whole overshoot, and then
    /// fails on chain with `DropBelowMinimum`.
    ///
    /// `init_if_needed` rather than `init`: a policy PDA can be reused once an
    /// earlier policy for the same holder and counter has settled, and its
    /// checkpoint outlives it. Reinitialising is handled below by writing
    /// every field.
    #[account(
        init_if_needed,
        payer = holder,
        space = PolicyBalanceCheckpoint::LEN,
        seeds = [CHECKPOINT_SEED, policy.key().as_ref()],
        bump,
    )]
    pub checkpoint: Box<Account<'info, PolicyBalanceCheckpoint>>,

    /// The agent's covered account, read only to bound the retention floor.
    ///
    /// Derived by Anchor from `agent_address`, so a holder cannot point the
    /// bound at some richer account of their choosing — the same constraint
    /// `declare_agent_mandate` uses, for the same reason. An agent with no
    /// covered account cannot be insured, and failing here says so at purchase
    /// rather than at the first claim.
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = agent_address,
    )]
    pub covered_token_account: Box<Account<'info, TokenAccount>>,

    #[account(constraint = usdc_mint.key() == config.usdc_mint @ CovanticError::InvalidTokenAccount)]
    pub usdc_mint: Box<Account<'info, Mint>>,

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
