use anchor_lang::prelude::*;

/// Who controlled the covered account, as read by this program.
///
/// The governance path's counterpart to `PolicyBalanceCheckpoint`, and it
/// exists for the same reason: the chain cannot be *told* what was true in
/// the past, but it can *read* what is true now and record it.
///
/// What it records is different, though, and that difference is the whole
/// argument for this trigger having its own settlement path. A balance
/// checkpoint sees a drain. It is completely blind to two shapes:
///
///   - **Seizure.** `SetAuthority(AccountOwner)` moves the account out of the
///     agent's control without moving a single token. The balance is
///     unchanged, so a subtraction reads zero.
///   - **Freeze.** The account is still the agent's and still full, and the
///     agent can no longer touch it.
///
/// Both are visible here, because both are fields on the token account.
#[account]
pub struct PolicyAuthorityCheckpoint {
    pub policy_id: u64,
    /// Token account the reading was taken from. Recorded so a reader can
    /// confirm the verdict was bounded against the account it claims.
    pub covered_account: Pubkey,

    pub owner: Pubkey,
    pub delegate: Option<Pubkey>,
    pub delegated_amount: u64,
    pub close_authority: Option<Pubkey>,
    pub frozen: bool,
    /// Balance at the same instant, so the authority reading and the value it
    /// governs can never be attributed to different moments.
    pub amount: u64,

    pub slot: u64,
    pub unix_timestamp: i64,

    /// The reading this one replaced. Without it, a crank tick landing after
    /// a takeover would overwrite the only pre-incident record of who was in
    /// charge — exactly the hole `prev_*` closes on the balance path.
    pub prev_owner: Pubkey,
    pub prev_delegate: Option<Pubkey>,
    pub prev_frozen: bool,
    pub prev_amount: u64,
    pub prev_slot: u64,
    pub prev_unix_timestamp: i64,

    pub bump: u8,
}

impl PolicyAuthorityCheckpoint {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // covered_account
        + 32                   // owner
        + 33                   // delegate
        + 8                    // delegated_amount
        + 33                   // close_authority
        + 1                    // frozen
        + 8                    // amount
        + 8                    // slot
        + 8                    // unix_timestamp
        + 32                   // prev_owner
        + 33                   // prev_delegate
        + 1                    // prev_frozen
        + 8                    // prev_amount
        + 8                    // prev_slot
        + 8                    // prev_unix_timestamp
        + 1; // bump
}

/// On-chain record of a governance payout the program bounded itself.
///
/// The counterpart to `ClaimEvidenceRecord` and `ExploitEvidenceRecord`, and
/// it records the same kind of thing: the facts the *program* read, not the
/// ones it was handed. Anyone holding the baseline and the two checkpoints
/// can recompute every bound below from them.
#[account]
pub struct GovernanceEvidenceRecord {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub covered_account: Pubkey,

    /// Who the holder declared should own it.
    pub declared_owner: Pubkey,
    /// Who owns it now, read by the program.
    pub observed_owner: Pubkey,
    pub observed_frozen: bool,
    /// Which departure the payout rests on, for a reader who does not want to
    /// re-derive it. See `GovernanceDeparture` in the instruction.
    pub departure_kind: u8,
    /// The address control actually landed on.
    pub departed_to: Pubkey,

    /// Balance at the pre-incident authority checkpoint.
    pub checkpoint_amount: u64,
    pub checkpoint_slot: u64,
    pub checkpoint_unix_timestamp: i64,

    /// Balance now, read by the program.
    pub current_amount: u64,
    /// `checkpoint_amount - current_amount`, computed here.
    pub observed_drop: u64,
    /// Value the program can see sitting under foreign control right now.
    pub seized_amount: u64,
    /// The bound the payout was actually held to.
    pub max_provable_loss: u64,
    pub payout_amount: u64,

    /// sha256 of the canonical off-chain evidence bundle. The chain proves
    /// control left the declared set; this commits to the claim about what it
    /// cost beyond what the chain can see.
    pub bundle_hash: [u8; 32],
    pub verified_at: i64,
    pub bump: u8,
}

impl GovernanceEvidenceRecord {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // holder
        + 32                   // covered_account
        + 32                   // declared_owner
        + 32                   // observed_owner
        + 1                    // observed_frozen
        + 1                    // departure_kind
        + 32                   // departed_to
        + 8                    // checkpoint_amount
        + 8                    // checkpoint_slot
        + 8                    // checkpoint_unix_timestamp
        + 8                    // current_amount
        + 8                    // observed_drop
        + 8                    // seized_amount
        + 8                    // max_provable_loss
        + 8                    // payout_amount
        + 32                   // bundle_hash
        + 8                    // verified_at
        + 1; // bump
}
