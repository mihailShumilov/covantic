use anchor_lang::prelude::*;

use crate::constants::{MAX_MANDATE_COUNTERPARTIES, MAX_MANDATE_PROGRAMS};

/// The operating envelope the holder declares for their agent.
///
/// This account is what makes an agent-error claim provable at all, and the
/// reason is worth stating plainly because it is not the same reason the
/// other three triggers work.
///
/// `verify_and_payout_v2` works because Pyth hands the chain a
/// guardian-signed statement about a past price. `verify_and_payout_exploit`
/// works because the program can read a balance twice and subtract.
/// `verify_and_payout_governance` works because the holder declares who may
/// control the agent, so authorisation becomes a set-membership test.
///
/// None of those help here. An agent error is a loss the agent caused *with
/// its own authority* — precisely the case the exploit path rejects as
/// `agent_authorized_movement`. Nothing on chain distinguishes a mistake from
/// a decision, because the distinction lives in the holder's intent, and no
/// instruction can read intent.
///
/// So this account does not try to. It has the holder pre-commit to the
/// envelope their agent is permitted to operate in, and then "was this a
/// mistake?" becomes "did the agent act outside what its owner declared?" —
/// a comparison of numbers the program holds.
///
/// **What that costs, stated once here.** It narrows the covered event. An
/// agent that loses money *inside* its declared envelope is not covered,
/// because its owner said that was permitted. The narrowing is the mechanism,
/// not a concession: it is the same trade `GovernanceBaseline` made when it
/// replaced "was this authorised?" with "is this in the declared set?".
///
/// Three properties carry the weight:
///
/// **Maturity.** `effective_at` sits `MANDATE_DECLARATION_DELAY` in the
/// future, and `verify_and_payout_agent_error` refuses a mandate that had not
/// matured before the claim was filed. Without it a holder could watch an
/// ordinary loss happen and then declare, retroactively, a mandate narrow
/// enough to have been breached by it.
///
/// **Retention.** `prev_*` keeps the declaration this one replaced, for the
/// same reason `PolicyBalanceCheckpoint` does: a refresh landing between the
/// incident and the claim must not erase the only usable "before".
///
/// **A floor under the numbers the chain can check.** Only the quantitative
/// dimensions — `max_single_outflow`, `min_retained_balance` — are re-checked
/// on chain against a balance the program reads for itself. The categorical
/// ones cannot be: the program cannot inspect the destination or the program
/// set of a *past* transaction. Those live in the allowlists below for the
/// off-chain verifier, and are recorded rather than enforced. Pretending
/// otherwise would be worse than committing to them and leaving the check to
/// a reader who can perform it.
#[account]
pub struct PolicyAgentMandate {
    pub policy_id: u64,
    pub holder: Pubkey,

    /// Largest single outflow, in base units of the covered mint, the agent is
    /// permitted to make. **Re-checked on chain.**
    pub max_single_outflow: u64,
    /// Largest cumulative outflow over `window_seconds`. Recorded, not
    /// enforced: the program holds one balance reading per policy and cannot
    /// sum a window of transfers from it.
    pub max_window_outflow: u64,
    pub window_seconds: i64,
    /// Balance the agent must never take the covered account below.
    /// **Re-checked on chain.**
    pub min_retained_balance: u64,

    /// Destinations the agent may send value to. Fixed-size so the account's
    /// rent and the stack cost of loading it are bounded;
    /// `counterparty_count` says how many slots are real, because the zero
    /// pubkey must never read as a permitted one.
    pub allowed_counterparties: [Pubkey; MAX_MANDATE_COUNTERPARTIES],
    pub counterparty_count: u8,
    /// Programs the agent may move value through. Same shape, same reason.
    pub allowed_programs: [Pubkey; MAX_MANDATE_PROGRAMS],
    pub program_count: u8,

    /// sha256 of the off-chain mandate covering anything richer than the
    /// fields above — per-venue caps, slippage bounds, rate limits.
    /// Committed, not interpreted.
    pub manifest_hash: [u8; 32],

    pub declared_at: i64,
    /// When this declaration becomes usable as proof.
    pub effective_at: i64,

    /// The declaration this one replaced.
    pub prev_max_single_outflow: u64,
    pub prev_min_retained_balance: u64,
    pub prev_effective_at: i64,

    pub bump: u8,
}

impl PolicyAgentMandate {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // holder
        + 8                    // max_single_outflow
        + 8                    // max_window_outflow
        + 8                    // window_seconds
        + 8                    // min_retained_balance
        + 32 * MAX_MANDATE_COUNTERPARTIES
        + 1                    // counterparty_count
        + 32 * MAX_MANDATE_PROGRAMS
        + 1                    // program_count
        + 32                   // manifest_hash
        + 8                    // declared_at
        + 8                    // effective_at
        + 8                    // prev_max_single_outflow
        + 8                    // prev_min_retained_balance
        + 8                    // prev_effective_at
        + 1; // bump

    /// Is `candidate` a destination the holder declared?
    ///
    /// The agent and the holder are *not* folded in here, matching
    /// `GovernanceBaseline::permits`: "is this declared?" and "is this still
    /// the family?" produce different rejection reasons, and collapsing them
    /// would lose that. Callers add them explicitly.
    pub fn permits_counterparty(&self, candidate: &Pubkey) -> bool {
        let count = (self.counterparty_count as usize).min(MAX_MANDATE_COUNTERPARTIES);
        self.allowed_counterparties[..count].contains(candidate)
    }

    /// Is `candidate` a program the holder declared?
    pub fn permits_program(&self, candidate: &Pubkey) -> bool {
        let count = (self.program_count as usize).min(MAX_MANDATE_PROGRAMS);
        self.allowed_programs[..count].contains(candidate)
    }

    /// The envelope in force at `at`, accounting for a refresh that landed
    /// after the incident.
    ///
    /// Returns `(max_single_outflow, min_retained_balance, effective_at)`.
    /// Same rule and same reason as `PolicyBalanceCheckpoint`'s `prev_*`: a
    /// declaration written after the claim was filed describes the aftermath,
    /// and the one it replaced is the one that still predates the incident.
    ///
    /// A *first* declaration has no predecessor and returns a zero
    /// `effective_at`, which the settlement instruction rejects. That is the
    /// maturity delay doing its job: before it elapses there is no envelope
    /// this policy can be judged against, and a claim goes to a reviewer.
    pub fn envelope_at(&self, at: i64) -> (u64, u64, i64) {
        if self.effective_at > 0 && self.effective_at <= at {
            (
                self.max_single_outflow,
                self.min_retained_balance,
                self.effective_at,
            )
        } else {
            (
                self.prev_max_single_outflow,
                self.prev_min_retained_balance,
                self.prev_effective_at,
            )
        }
    }
}

/// On-chain record of an agent-error payout the program bounded itself.
///
/// The counterpart to `ExploitEvidenceRecord` and `GovernanceEvidenceRecord`,
/// recording the same kind of thing: the numbers the *program* derived, not
/// the ones it was handed. `observed_drop` is a subtraction between two
/// balances read from a constrained account, and `breach_excess` is the
/// amount by which that drop exceeded an envelope the holder signed for —
/// so anyone can recompute the bound from the checkpoint, the mandate, and
/// the payout.
///
/// `breach_kind` names which declared bound was crossed — the single-outflow
/// cap or the retention floor. Both are quantitative and both were re-derived
/// on chain; a breach of the mandate's counterparty or program allowlists
/// produces no overshoot and is never settled here, because the program cannot
/// inspect a past transaction to check one.
#[account]
pub struct AgentErrorEvidenceRecord {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub covered_account: Pubkey,

    /// The envelope in force when the claim was filed.
    pub declared_max_single_outflow: u64,
    pub declared_min_retained_balance: u64,
    pub mandate_effective_at: i64,

    pub checkpoint_amount: u64,
    pub checkpoint_slot: u64,
    pub checkpoint_unix_timestamp: i64,

    pub current_amount: u64,
    /// `checkpoint_amount - current_amount`, computed here.
    pub observed_drop: u64,
    /// How far outside the declared envelope the drop landed. Always > 0 on a
    /// settled claim: this is the bound.
    pub breach_excess: u64,
    /// Which declared bound was crossed. See `BREACH_OUTFLOW_CAP` /
    /// `BREACH_RETAINED_FLOOR` in the instruction module.
    pub breach_kind: u8,

    pub max_provable_loss: u64,
    pub payout_amount: u64,

    /// sha256 of the canonical off-chain evidence bundle.
    pub bundle_hash: [u8; 32],
    pub verified_at: i64,
    pub bump: u8,
}

impl AgentErrorEvidenceRecord {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // holder
        + 32                   // covered_account
        + 8                    // declared_max_single_outflow
        + 8                    // declared_min_retained_balance
        + 8                    // mandate_effective_at
        + 8                    // checkpoint_amount
        + 8                    // checkpoint_slot
        + 8                    // checkpoint_unix_timestamp
        + 8                    // current_amount
        + 8                    // observed_drop
        + 8                    // breach_excess
        + 1                    // breach_kind
        + 8                    // max_provable_loss
        + 8                    // payout_amount
        + 32                   // bundle_hash
        + 8                    // verified_at
        + 1; // bump
}
