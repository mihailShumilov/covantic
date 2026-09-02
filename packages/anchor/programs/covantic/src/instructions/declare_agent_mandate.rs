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

impl AgentMandate {
    /// The commitment a premium is quoted against.
    ///
    /// The deductible has to be priced, and it can only be priced if the
    /// oracle and the program agree on *which* envelope was quoted. This is
    /// that agreement: the oracle hashes the envelope it priced into the
    /// attestation, and `create_policy` recomputes the hash from the arguments
    /// it was handed and refuses a mismatch.
    ///
    /// The layout is written out explicitly rather than delegating to Borsh.
    /// The other side of this hash is TypeScript, and a serialisation format
    /// two languages merely *happen* to agree on is one an upgrade can quietly
    /// split — after which every purchase fails, or worse, a stale commitment
    /// keeps matching. Explicit little-endian fields and sorted keys are
    /// something both sides can implement from the description.
    ///
    /// `manifest_hash` is deliberately excluded. It commits to off-chain terms
    /// the program cannot read and the oracle does not price; folding it in
    /// would make the quote depend on a value neither side can check.
    pub fn commitment(&self) -> [u8; 32] {
        let mut bytes = Vec::with_capacity(32 + 33 * 16);
        bytes.extend_from_slice(&self.max_single_outflow.to_le_bytes());
        bytes.extend_from_slice(&self.max_window_outflow.to_le_bytes());
        bytes.extend_from_slice(&self.window_seconds.to_le_bytes());
        bytes.extend_from_slice(&self.min_retained_balance.to_le_bytes());

        // Sorted, so the same declared set hashes the same however a client
        // ordered it. An unsorted list would make the commitment depend on
        // form-field order.
        let mut counterparties: Vec<[u8; 32]> =
            self.allowed_counterparties.iter().map(|k| k.to_bytes()).collect();
        counterparties.sort_unstable();
        bytes.push(counterparties.len() as u8);
        for k in &counterparties {
            bytes.extend_from_slice(k);
        }

        let mut programs: Vec<[u8; 32]> =
            self.allowed_programs.iter().map(|k| k.to_bytes()).collect();
        programs.sort_unstable();
        bytes.push(programs.len() as u8);
        for k in &programs {
            bytes.extend_from_slice(k);
        }

        solana_sha256_hasher::hash(&bytes).to_bytes()
    }
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

/// The checks every declaration must pass, wherever it is made.
///
/// Shared because the envelope is now declared in two places — at purchase,
/// where its price is fixed, and on a later refresh — and a rule enforced in
/// one of them is a rule an attacker uses the other to skip.
pub(crate) fn validate_mandate(mandate: &AgentMandate, covered_balance: u64) -> Result<()> {
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
        mandate.min_retained_balance <= covered_balance,
        CovanticError::InvalidAgentMandate
    );

    Ok(())
}

/// Write a validated envelope into its account.
///
/// Returns nothing the caller has to interpret: maturity, the predecessor
/// fields and the event are all part of declaring, and splitting them across
/// call sites is how the `prev_*` seeding bug described above gets reintroduced.
pub(crate) fn write_mandate(
    record: &mut PolicyAgentMandate,
    mandate: &AgentMandate,
    policy_id: u64,
    holder: Pubkey,
    now: i64,
    bump: u8,
) -> Result<()> {
    let is_new = record.policy_id == 0 && record.effective_at == 0;
    let prev_max_single_outflow = if is_new { 0 } else { record.max_single_outflow };
    let prev_min_retained_balance = if is_new { 0 } else { record.min_retained_balance };
    let prev_effective_at = if is_new { 0 } else { record.effective_at };

    record.policy_id = policy_id;
    record.holder = holder;
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
    record.bump = bump;

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
    validate_mandate(&mandate, ctx.accounts.covered_token_account.amount)?;

    // A refresh may only *widen*.
    //
    // The premium was quoted against the envelope declared at purchase, and a
    // narrower one is a larger exposure the vault was never paid for. Without
    // this, everything `create_policy` now checks could be undone a block
    // later: buy against a generous envelope, tighten it to guarantee a
    // breach, collect the overshoot. Widening is free because it can only ever
    // reduce what the vault owes.
    let record = &mut ctx.accounts.mandate;
    let is_refresh = !(record.policy_id == 0 && record.effective_at == 0);
    if is_refresh {
        require!(
            mandate.max_single_outflow >= record.max_single_outflow
                && mandate.max_window_outflow >= record.max_window_outflow
                && mandate.min_retained_balance <= record.min_retained_balance,
            CovanticError::InvalidAgentMandate
        );
    }

    let policy_id = ctx.accounts.policy.policy_id;
    let holder = ctx.accounts.policy.holder;
    let bump = ctx.bumps.mandate;
    write_mandate(&mut ctx.accounts.mandate, &mandate, policy_id, holder, now, bump)?;

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

#[cfg(test)]
mod commitment_tests {
    use super::*;

    fn key(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn envelope(counterparties: Vec<Pubkey>, programs: Vec<Pubkey>) -> AgentMandate {
        AgentMandate {
            max_single_outflow: 100_000_000,
            max_window_outflow: 150_000_000,
            window_seconds: 3_600,
            min_retained_balance: 4_600_000_000,
            allowed_counterparties: counterparties,
            allowed_programs: programs,
            manifest_hash: [7u8; 32],
        }
    }

    /// The vector the TypeScript half is tested against.
    ///
    /// Both sides implement this layout from its description rather than from
    /// each other, so something has to hold them together. If this constant
    /// changes, `mandate-commitment.test.ts` fails too — and if only one side
    /// changes, only one fails, which is the signal worth having.
    #[test]
    fn commits_to_a_known_value() {
        let hash = envelope(vec![key(1)], vec![key(2)]).commitment();
        assert_eq!(
            hex(&hash),
            "121da6db6c63adfbd79263f232f1f109da30043c1cad5dd7708c6af28b4ae515"
        );
    }

    /// Order must not matter: a form that collects two addresses in the other
    /// order would otherwise quote a different premium for the same envelope.
    #[test]
    fn is_independent_of_the_order_keys_arrive_in() {
        let a = envelope(vec![key(1), key(9)], vec![key(2), key(8)]).commitment();
        let b = envelope(vec![key(9), key(1)], vec![key(8), key(2)]).commitment();
        assert_eq!(a, b);
    }

    /// The whole point: a different deductible is a different commitment, so
    /// an attestation priced for one cannot be spent on the other.
    #[test]
    fn a_narrower_cap_is_a_different_commitment() {
        let quoted = envelope(vec![], vec![]);
        let mut narrowed = envelope(vec![], vec![]);
        narrowed.max_single_outflow = 1_000_000;

        assert_ne!(quoted.commitment(), narrowed.commitment());
    }

    /// `manifest_hash` is excluded deliberately — it commits to terms the
    /// program cannot read and the oracle does not price.
    #[test]
    fn ignores_the_off_chain_manifest() {
        let mut a = envelope(vec![], vec![]);
        let mut b = envelope(vec![], vec![]);
        a.manifest_hash = [1u8; 32];
        b.manifest_hash = [2u8; 32];

        assert_eq!(a.commitment(), b.commitment());
    }

    fn hex(bytes: &[u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}
