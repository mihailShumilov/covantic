use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::CovanticError;
use crate::events::AgentMandateDeclared;
use crate::state::{InsurancePolicy, PolicyAgentMandate, ProtocolConfig};

/// What the holder commits to about how their agent is permitted to operate.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AgentMandate {
    /// Largest single outflow the agent may make, in base units of the
    /// covered mint.
    pub max_single_outflow: u64,
    /// Largest cumulative outflow over `window_seconds`.
    pub max_window_outflow: u64,
    pub window_seconds: i64,
    /// Balance the agent must never take the covered account below.
    pub min_retained_balance: u64,
    /// Destinations the agent may send value to. Capped at
    /// {@link MAX_MANDATE_COUNTERPARTIES}.
    pub allowed_counterparties: Vec<Pubkey>,
    /// Programs the agent may move value through. Capped at
    /// {@link MAX_MANDATE_PROGRAMS}.
    pub allowed_programs: Vec<Pubkey>,
    /// sha256 of the off-chain mandate covering anything richer.
    pub manifest_hash: [u8; 32],
}

/// Declare — or refresh — the operating envelope that is legitimate for an
/// agent.
///
/// **Holder-signed, and that is the entire point**, for the same reason
/// `declare_governance_baseline` is. Every other evidence mechanism in this
/// protocol has the operator asserting something about the policyholder's
/// situation. Here the policyholder asserts it themselves, in advance, and the
/// program later checks reality against their own statement.
///
/// What it converts is a question no instruction can answer. An agent error is
/// a loss the agent caused *with its own authority*; nothing on chain
/// separates a mistake from a decision, because the separation lives in the
/// holder's intent. This turns "was this a mistake?" into "did the agent act
/// outside the envelope its owner declared?", which is a comparison of numbers.
///
/// Two rules make the statement worth anything, and they are the same two the
/// governance path relies on:
///
/// **It matures on a delay.** `effective_at` is `MANDATE_DECLARATION_DELAY` in
/// the future, and `verify_and_payout_agent_error` refuses a mandate that had
/// not matured before the claim was filed. Without that, a holder could watch
/// an ordinary loss happen and then declare, retroactively, an envelope narrow
/// enough to have been breached by it. With it, that manoeuvre has to be
/// committed to on chain, in public, an hour before an incident the holder
/// must then arrange to happen.
///
/// **The previous declaration is retained.** A refresh keeps `prev_*`, so a
/// rotation landing between the incident and the claim cannot erase the only
/// usable "before" — the same hole `PolicyBalanceCheckpoint.prev_*` closes.
///
/// **The abuse this does *not* fully close, stated honestly.** A holder may
/// declare an absurdly narrow envelope — `max_single_outflow = 1` — so that
/// every transfer breaches it. Three things bound that and are meant to ship
/// together: the payout is capped by a drop the chain *measured*, so a breach
/// with no loss pays nothing; `MIN_PROVABLE_MANDATE_BREACH` puts a floor under
/// what is worth an instruction at all; and the quote path reads the mandate,
/// so an envelope that makes ordinary operation a breach is priced rather than
/// free. Until pricing reads it, this is the weakest edge of the trigger.
///
/// What the program does *not* do is interpret `manifest_hash`, or enforce the
/// two allowlists. It cannot inspect the destination or the program set of a
/// *past* transaction — the only thing it can read is the covered account's
/// balance now — so those dimensions are recorded for the off-chain verifier
/// and committed to permanently. Pretending to enforce them would be worse
/// than committing to them and leaving the check to a reader who can perform
/// it.
pub fn declare_agent_mandate_handler(
    ctx: Context<DeclareAgentMandate>,
    mandate: AgentMandate,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let policy = &ctx.accounts.policy;

    require!(
        policy.state == InsurancePolicy::STATE_ACTIVE,
        CovanticError::PolicyNotActive
    );
    // A zero cap would make every outflow a breach, and a zero window would
    // make the window cap meaningless. Neither is a mandate; both are almost
    // certainly a client that failed to fill the form in.
    require!(
        mandate.max_single_outflow > 0 && mandate.window_seconds > 0,
        CovanticError::InvalidAgentMandate
    );
    // The window cap bounds a sum of outflows, so it cannot be smaller than a
    // single permitted one without contradicting itself.
    require!(
        mandate.max_window_outflow >= mandate.max_single_outflow,
        CovanticError::InvalidAgentMandate
    );
    require!(
        mandate.allowed_counterparties.len() <= MAX_MANDATE_COUNTERPARTIES,
        CovanticError::TooManyMandateCounterparties
    );
    require!(
        mandate.allowed_programs.len() <= MAX_MANDATE_PROGRAMS,
        CovanticError::TooManyMandatePrograms
    );
    // The zero pubkey must never end up in a permitted set: every unset slot
    // in the fixed arrays is zero, and an attacker who could get value routed
    // to it would land inside the declared set for free.
    require!(
        !mandate.allowed_counterparties.contains(&Pubkey::default())
            && !mandate.allowed_programs.contains(&Pubkey::default()),
        CovanticError::InvalidAgentMandate
    );
    // The retention floor is a deductible the holder authors, and it was the
    // one declared dimension nothing bounded — on chain or off.
    //
    // `floor_excess` is `min(floor - retained, outflow)`, so a floor declared
    // far above what the account actually holds makes the excess equal the
    // *entire* movement. That turns "we pay the overshoot beyond what you said
    // you would risk" into "we pay the whole loss", and it is the arithmetic
    // bound the whole trigger rests on.
    //
    // A holder may only declare a floor they currently satisfy. Declaring one
    // you already breach is not a statement about how you intend to operate.
    require!(
        mandate.min_retained_balance <= ctx.accounts.covered_token_account.amount,
        CovanticError::InvalidAgentMandate
    );

    let record = &mut ctx.accounts.mandate;
    let is_new = record.policy_id == 0 && record.effective_at == 0;

    // A first declaration has **no predecessor**, and `prev_effective_at`
    // stays zero to say so. Seeding it with the new envelope and `now` would
    // be the natural-looking thing to write and would silently destroy the
    // entire mechanism: `envelope_at` falls back to `prev_*` for a claim filed
    // before the declaration matured, so a self-dated predecessor would be
    // usable as proof the instant it was written — which is exactly what the
    // delay exists to prevent. Zero fails the maturity check below instead,
    // and the claim goes to a reviewer.
    //
    // On a *refresh* the predecessor is real and had matured, so it is
    // retained: a rotation landing between the incident and the claim must not
    // erase the only usable "before".
    let prev_max_single_outflow = if is_new { 0 } else { record.max_single_outflow };
    let prev_min_retained_balance = if is_new { 0 } else { record.min_retained_balance };
    let prev_effective_at = if is_new { 0 } else { record.effective_at };

    record.policy_id = policy.policy_id;
    record.holder = policy.holder;
    record.max_single_outflow = mandate.max_single_outflow;
    record.max_window_outflow = mandate.max_window_outflow;
    record.window_seconds = mandate.window_seconds;
    record.min_retained_balance = mandate.min_retained_balance;

    record.allowed_counterparties = [Pubkey::default(); MAX_MANDATE_COUNTERPARTIES];
    for (slot, key) in mandate.allowed_counterparties.iter().enumerate() {
        record.allowed_counterparties[slot] = *key;
    }
    record.counterparty_count = mandate.allowed_counterparties.len() as u8;

    record.allowed_programs = [Pubkey::default(); MAX_MANDATE_PROGRAMS];
    for (slot, key) in mandate.allowed_programs.iter().enumerate() {
        record.allowed_programs[slot] = *key;
    }
    record.program_count = mandate.allowed_programs.len() as u8;

    record.manifest_hash = mandate.manifest_hash;
    record.declared_at = now;
    record.effective_at = now
        .checked_add(MANDATE_DECLARATION_DELAY)
        .ok_or(CovanticError::MathOverflow)?;
    record.prev_max_single_outflow = prev_max_single_outflow;
    record.prev_min_retained_balance = prev_min_retained_balance;
    record.prev_effective_at = prev_effective_at;
    record.bump = ctx.bumps.mandate;

    emit!(AgentMandateDeclared {
        policy_id: record.policy_id,
        holder: record.holder,
        max_single_outflow: record.max_single_outflow,
        max_window_outflow: record.max_window_outflow,
        window_seconds: record.window_seconds,
        min_retained_balance: record.min_retained_balance,
        counterparty_count: record.counterparty_count,
        program_count: record.program_count,
        manifest_hash: record.manifest_hash,
        declared_at: record.declared_at,
        effective_at: record.effective_at,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DeclareAgentMandate<'info> {
    /// The policyholder. Nobody else may say what their agent is permitted to
    /// do — least of all the oracle, whose discretion this account exists to
    /// constrain.
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
        space = PolicyAgentMandate::LEN,
        seeds = [AGENT_MANDATE_SEED, policy.key().as_ref()],
        bump,
    )]
    pub mandate: Box<Account<'info, PolicyAgentMandate>>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,

    /// The covered account, read here only to bound the retention floor.
    ///
    /// Derived by Anchor from the policy's own agent address, exactly as in
    /// `verify_and_payout_agent_error`, so the holder cannot point the bound
    /// at some richer account of their choosing.
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = policy.agent_address,
    )]
    pub covered_token_account: Box<Account<'info, TokenAccount>>,

    #[account(constraint = usdc_mint.key() == config.usdc_mint @ CovanticError::InvalidTokenAccount)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub system_program: Program<'info, System>,
}
