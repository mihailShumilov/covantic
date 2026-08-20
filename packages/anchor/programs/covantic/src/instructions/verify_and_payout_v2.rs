use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::{ClaimPaid, ClaimProofVerified};
use crate::state::{ClaimEvidenceRecord, InsurancePolicy, InsuranceVault, ProtocolConfig};

/// What the oracle commits to when claiming an oracle-manipulation loss.
///
/// Every field here is checked against the guardian-signed price update, the
/// policy's own on-chain history, or arithmetic the program performs itself.
/// The oracle chooses these numbers; it does not get to have them believed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PayoutEvidence {
    /// Pyth feed the reference price must come from.
    pub feed_id: [u8; 32],
    /// Block time of the trigger transaction.
    pub trigger_block_time: i64,
    /// Price the transaction executed at, at the price update's exponent.
    pub executed_price: i64,
    /// Quantity of the subject asset, in its own base units.
    pub subject_quantity: u64,
    pub subject_decimals: u8,
    /// sha256 of the canonical off-chain evidence bundle.
    pub bundle_hash: [u8; 32],
}

/// Verify a claim against a guardian-signed price and execute payout.
///
/// The difference from `verify_and_payout` is the whole point of this
/// instruction. There, the program checks that the caller is the oracle and
/// that the amount fits the coverage, and takes everything else on faith — so
/// a stolen oracle key is worth the entire vault, with nothing on chain to
/// contradict it afterwards.
///
/// Here the program checks the price itself. The reference comes out of a
/// `PriceUpdateV2` account, which the Pyth receiver program will only have
/// written after verifying the Wormhole guardians' signatures over it. This
/// instruction then confirms it is the right feed, that it was published in
/// the right window relative to the claim, that the committed execution
/// really does deviate from it, and that the payout is no larger than that
/// deviation can arithmetically account for.
///
/// What remains trusted, stated plainly: the chain cannot read the historical
/// swap, so `executed_price`, `subject_quantity` and `trigger_block_time` are
/// asserted by the oracle rather than proven. Three things constrain them —
/// they are committed on chain, `bundle_hash` binds them to a published
/// evidence bundle anyone can recompute, and the lock period leaves a window
/// in which a contradicting bundle can be produced. A false commitment is
/// therefore permanent and publicly falsifiable, rather than invisible.
pub fn verify_and_payout_v2_handler(
    ctx: Context<VerifyAndPayoutV2>,
    payout_amount: u64,
    evidence: PayoutEvidence,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let policy = &mut ctx.accounts.policy;
    let vault_info = ctx.accounts.vault.to_account_info();
    let vault = &mut ctx.accounts.vault;
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

    // This path proves a *price*. It has nothing to say about an exploit or a
    // governance attack, and must not be used to wave one through.
    require!(
        policy.trigger_type == TRIGGER_ORACLE_MANIPULATION,
        CovanticError::InvalidTriggerType
    );

    require!(
        payout_amount <= policy.coverage_amount,
        CovanticError::PayoutExceedsCoverage
    );

    let lock_expires_at = policy
        .claim_submitted_at
        .checked_add(LOCK_ORACLE_MANIPULATION)
        .ok_or(CovanticError::MathOverflow)?;
    require!(now >= lock_expires_at, CovanticError::LockPeriodNotElapsed);

    // ---- price evidence ------------------------------------------------
    // `get_price_unchecked`, not `get_price_no_older_than`: the recency check
    // that helper performs is against the *current* clock, and every claim
    // here is retrospective by construction — the transaction under review
    // happened before the claim, which happened before the lock elapsed. The
    // right check is against the claim's own timeline, below.
    let price = ctx
        .accounts
        .price_update
        .get_price_unchecked(&evidence.feed_id)
        .map_err(|_| error!(CovanticError::InvalidPriceEvidence))?;

    require!(
        price.exponent == PRICE_EVIDENCE_EXPO,
        CovanticError::InvalidPriceEvidence
    );
    require!(price.price > 0, CovanticError::InvalidPriceEvidence);

    // The reference must sit next to the transaction it is meant to price.
    let skew = price
        .publish_time
        .checked_sub(evidence.trigger_block_time)
        .ok_or(CovanticError::MathOverflow)?
        .abs();
    require!(
        skew <= MAX_PRICE_EVIDENCE_SKEW,
        CovanticError::PriceEvidenceSkew
    );

    // And the transaction must sit inside the claim's own history: after the
    // policy started, and not implausibly long before the claim was filed.
    require!(
        evidence.trigger_block_time >= policy.start_time
            && evidence.trigger_block_time <= policy.claim_submitted_at,
        CovanticError::PriceEvidenceOutOfWindow
    );
    let claim_lag = policy
        .claim_submitted_at
        .checked_sub(evidence.trigger_block_time)
        .ok_or(CovanticError::MathOverflow)?;
    require!(
        claim_lag <= MAX_CLAIM_EVIDENCE_LAG,
        CovanticError::PriceEvidenceOutOfWindow
    );

    // ---- recompute the deviation ----------------------------------------
    require!(evidence.executed_price > 0, CovanticError::InvalidPriceEvidence);
    require!(
        evidence.subject_decimals <= MAX_SUBJECT_DECIMALS,
        CovanticError::InvalidPriceEvidence
    );
    require!(evidence.subject_quantity > 0, CovanticError::InvalidPriceEvidence);

    let reference = price.price;
    let delta = (evidence.executed_price - reference).unsigned_abs() as u128;
    let deviation_bps = delta
        .checked_mul(10_000)
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(reference as u128)
        .ok_or(CovanticError::MathOverflow)?;
    require!(
        deviation_bps >= MIN_PROVABLE_DEVIATION_BPS as u128,
        CovanticError::DeviationBelowMinimum
    );

    // ---- bound the payout by what the signed price can support -----------
    // max_loss (USDC 6dp) = delta * quantity * 10^6
    //                       / 10^(-expo) / 10^(subject_decimals)
    //
    // Every input is either guardian-signed (`reference`) or committed on
    // chain, so the bound is reproducible by anyone reading this account.
    let scale = pow10(PRICE_EVIDENCE_EXPO.unsigned_abs())
        .checked_mul(pow10(evidence.subject_decimals as u32))
        .ok_or(CovanticError::MathOverflow)?;
    let max_provable_loss_u128 = delta
        .checked_mul(evidence.subject_quantity as u128)
        .ok_or(CovanticError::MathOverflow)?
        .checked_mul(1_000_000u128)
        .ok_or(CovanticError::MathOverflow)?
        .checked_div(scale)
        .ok_or(CovanticError::MathOverflow)?;
    let max_provable_loss =
        u64::try_from(max_provable_loss_u128).map_err(|_| error!(CovanticError::MathOverflow))?;

    require!(
        payout_amount <= max_provable_loss,
        CovanticError::PayoutExceedsProvenLoss
    );

    // ---- payout ----------------------------------------------------------
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

    // Loss cascade, identical to the v1 path: treasury, then reserve, then
    // staker principal. Kept in step deliberately — a payout must have the
    // same effect on solvency however it was proven.
    let mut remaining = payout_amount;

    let from_treasury = remaining.min(vault.protocol_treasury);
    vault.protocol_treasury = vault
        .protocol_treasury
        .checked_sub(from_treasury)
        .ok_or(CovanticError::MathOverflow)?;
    remaining = remaining
        .checked_sub(from_treasury)
        .ok_or(CovanticError::MathOverflow)?;

    let from_reserve = remaining.min(vault.reserve_fund);
    vault.reserve_fund = vault
        .reserve_fund
        .checked_sub(from_reserve)
        .ok_or(CovanticError::MathOverflow)?;
    remaining = remaining
        .checked_sub(from_reserve)
        .ok_or(CovanticError::MathOverflow)?;

    if remaining > 0 {
        vault.total_staked = vault
            .total_staked
            .checked_sub(remaining)
            .ok_or(CovanticError::InsufficientVaultBalance)?;
    }

    vault.total_coverage = vault
        .total_coverage
        .checked_sub(policy.coverage_amount)
        .ok_or(CovanticError::MathOverflow)?;
    vault.recalculate_solvency();

    policy.state = InsurancePolicy::STATE_CLAIM_PAID;
    policy.payout_amount = payout_amount;

    // ---- record what was proven ------------------------------------------
    let record = &mut ctx.accounts.evidence_record;
    record.policy_id = policy.policy_id;
    record.holder = policy.holder;
    record.feed_id = evidence.feed_id;
    record.expo = price.exponent;
    record.reference_price = reference;
    record.executed_price = evidence.executed_price;
    record.subject_quantity = evidence.subject_quantity;
    record.subject_decimals = evidence.subject_decimals;
    record.price_publish_time = price.publish_time;
    record.trigger_block_time = evidence.trigger_block_time;
    record.deviation_bps = deviation_bps as u32;
    record.max_provable_loss = max_provable_loss;
    record.payout_amount = payout_amount;
    record.bundle_hash = evidence.bundle_hash;
    record.verified_at = now;
    record.bump = ctx.bumps.evidence_record;

    emit!(ClaimProofVerified {
        policy_id: policy.policy_id,
        feed_id: evidence.feed_id,
        reference_price: reference,
        executed_price: evidence.executed_price,
        deviation_bps: deviation_bps as u32,
        max_provable_loss,
        payout_amount,
        bundle_hash: evidence.bundle_hash,
        price_publish_time: price.publish_time,
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

/// `10^exp` as u128. Bounded by the callers above (exponent magnitude and
/// token decimals are both checked before use), so it cannot run away.
fn pow10(exp: u32) -> u128 {
    10u128.saturating_pow(exp)
}

#[derive(Accounts)]
pub struct VerifyAndPayoutV2<'info> {
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

    /// Guardian-signed price update, posted by the Pyth receiver program.
    ///
    /// Typing it as `Account<'info, PriceUpdateV2>` is what makes this
    /// trustworthy: Anchor enforces that the account is owned by the Pyth
    /// receiver, and the receiver only writes one after checking the Wormhole
    /// guardians' signatures. A fabricated account fails deserialization
    /// before any of the logic above runs.
    pub price_update: Box<Account<'info, PriceUpdateV2>>,

    /// Immutable record of what was proven. `init` rather than
    /// `init_if_needed`: one policy, one proven payout, and a second attempt
    /// should fail loudly rather than overwrite the first.
    #[account(
        init,
        payer = oracle,
        space = ClaimEvidenceRecord::LEN,
        seeds = [CLAIM_EVIDENCE_SEED, policy.key().as_ref()],
        bump,
    )]
    pub evidence_record: Box<Account<'info, ClaimEvidenceRecord>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
