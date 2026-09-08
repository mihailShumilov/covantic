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
///     agent can no longer act.
///
/// Both are visible here, because both are fields on the token account.
///
/// **What `prev_*` means, precisely.** It is the reading taken immediately
/// before the most recent *change in who controls the account* — owner,
/// delegate, close authority or frozen flag — not merely the previous tick.
/// A rolling "last reading" was the wrong shape twice over: the crank ticks
/// every couple of minutes, so two ticks after a takeover the pre-takeover
/// reading was gone entirely, and any caller could erase the evidence of a
/// freeze on purpose by checkpointing a frozen account twice.
/// `checkpoint_authority` therefore advances `prev_*` only when the authority
/// tuple it observes differs from the one it stored, and holds it otherwise.
/// A first reading has no predecessor and says so with `prev_slot == 0`.
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

    /// The reading before the last change of control. See the account docs.
    pub prev_owner: Pubkey,
    pub prev_delegate: Option<Pubkey>,
    pub prev_frozen: bool,
    pub prev_amount: u64,
    pub prev_slot: u64,
    pub prev_unix_timestamp: i64,

    pub bump: u8,

    // ---- appended after `bump`, on purpose ------------------------------
    // Checkpoints written before this field existed end at `bump`; inserting
    // it above would shift `bump` for every one of them. Appended, an account
    // grown by `migrate_authority_checkpoint` reads it as `None`.
    /// Close authority at the predecessor reading. Without it a pre-existing
    /// foreign close authority could be presented as one that arrived later.
    pub prev_close_authority: Option<Pubkey>,
}

/// One reading of who controlled the covered account, and what it held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorityReading {
    pub owner: Pubkey,
    pub delegate: Option<Pubkey>,
    pub close_authority: Option<Pubkey>,
    pub frozen: bool,
    pub amount: u64,
    pub slot: u64,
    pub unix_timestamp: i64,
}

impl AuthorityReading {
    /// Whether control — as opposed to value — differs between two readings.
    pub fn control_differs(&self, other: &AuthorityReading) -> bool {
        self.owner != other.owner
            || self.delegate != other.delegate
            || self.close_authority != other.close_authority
            || self.frozen != other.frozen
    }
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
        + 1                    // bump
        + 33; // prev_close_authority

    /// The most recent reading.
    pub fn current(&self) -> AuthorityReading {
        AuthorityReading {
            owner: self.owner,
            delegate: self.delegate,
            close_authority: self.close_authority,
            frozen: self.frozen,
            amount: self.amount,
            slot: self.slot,
            unix_timestamp: self.unix_timestamp,
        }
    }

    /// The reading before the last change of control, if there is one.
    ///
    /// A first checkpoint records no predecessor: seeding one from the
    /// reading itself is what let a takeover that predated the first crank
    /// tick pass as a transition the program had witnessed.
    pub fn predecessor(&self) -> Option<AuthorityReading> {
        if self.prev_slot == 0 && self.prev_unix_timestamp == 0 {
            return None;
        }
        Some(AuthorityReading {
            owner: self.prev_owner,
            delegate: self.prev_delegate,
            close_authority: self.prev_close_authority,
            frozen: self.prev_frozen,
            amount: self.prev_amount,
            slot: self.prev_slot,
            unix_timestamp: self.prev_unix_timestamp,
        })
    }

    /// Write a reading, keeping or replacing the predecessor by the rule in
    /// the account docs. `first` says whether this is the account's first
    /// reading, in which case the predecessor is recorded as absent.
    pub fn record(&mut self, observed: &AuthorityReading, delegated_amount: u64, first: bool) {
        if first {
            self.prev_owner = Pubkey::default();
            self.prev_delegate = None;
            self.prev_close_authority = None;
            self.prev_frozen = false;
            self.prev_amount = 0;
            self.prev_slot = 0;
            self.prev_unix_timestamp = 0;
        } else {
            let current = self.current();
            if current.control_differs(observed) {
                // Control changed: the reading being replaced is the one that
                // preceded the change, and it becomes the predecessor.
                self.prev_owner = current.owner;
                self.prev_delegate = current.delegate;
                self.prev_close_authority = current.close_authority;
                self.prev_frozen = current.frozen;
                self.prev_amount = current.amount;
                self.prev_slot = current.slot;
                self.prev_unix_timestamp = current.unix_timestamp;
            }
            // Otherwise hold the predecessor: consecutive readings of the same
            // control state must not erase the transition into it.
        }

        self.owner = observed.owner;
        self.delegate = observed.delegate;
        self.delegated_amount = delegated_amount;
        self.close_authority = observed.close_authority;
        self.frozen = observed.frozen;
        self.amount = observed.amount;
        self.slot = observed.slot;
        self.unix_timestamp = observed.unix_timestamp;
    }
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
    /// re-derive it. See `DEPARTURE_*` in `constants.rs`.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(owner: Pubkey, frozen: bool, amount: u64, t: i64) -> AuthorityReading {
        AuthorityReading {
            owner,
            delegate: None,
            close_authority: None,
            frozen,
            amount,
            slot: t as u64,
            unix_timestamp: t,
        }
    }

    fn empty() -> PolicyAuthorityCheckpoint {
        PolicyAuthorityCheckpoint {
            policy_id: 0,
            covered_account: Pubkey::default(),
            owner: Pubkey::default(),
            delegate: None,
            delegated_amount: 0,
            close_authority: None,
            frozen: false,
            amount: 0,
            slot: 0,
            unix_timestamp: 0,
            prev_owner: Pubkey::default(),
            prev_delegate: None,
            prev_frozen: false,
            prev_amount: 0,
            prev_slot: 0,
            prev_unix_timestamp: 0,
            bump: 0,
            prev_close_authority: None,
        }
    }

    #[test]
    fn a_first_reading_has_no_predecessor() {
        let mut cp = empty();
        cp.record(&reading(Pubkey::new_unique(), false, 5, 100), 0, true);
        assert!(cp.predecessor().is_none());
        assert_eq!(cp.current().amount, 5);
    }

    #[test]
    fn a_change_of_control_pins_the_reading_before_it() {
        let agent = Pubkey::new_unique();
        let attacker = Pubkey::new_unique();
        let mut cp = empty();
        cp.record(&reading(agent, false, 100, 10), 0, true);
        cp.record(&reading(agent, false, 100, 20), 0, false);
        // Same control, later tick: still no predecessor.
        assert!(cp.predecessor().is_none());

        cp.record(&reading(attacker, false, 100, 30), 0, false);
        let before = cp.predecessor().expect("pinned");
        assert_eq!(before.owner, agent);
        assert_eq!(before.unix_timestamp, 20);

        // Further readings of the same seized state do not dislodge it.
        cp.record(&reading(attacker, false, 0, 40), 0, false);
        cp.record(&reading(attacker, false, 0, 50), 0, false);
        let still = cp.predecessor().expect("held");
        assert_eq!(still.owner, agent);
        assert_eq!(still.unix_timestamp, 20);
        assert_eq!(still.amount, 100);
    }

    #[test]
    fn repeated_frozen_readings_keep_the_unfrozen_predecessor() {
        let agent = Pubkey::new_unique();
        let mut cp = empty();
        cp.record(&reading(agent, false, 100, 10), 0, true);
        cp.record(&reading(agent, false, 100, 20), 0, false);
        cp.record(&reading(agent, true, 100, 30), 0, false);
        cp.record(&reading(agent, true, 100, 40), 0, false);
        cp.record(&reading(agent, true, 100, 50), 0, false);
        let before = cp.predecessor().expect("pinned");
        assert!(!before.frozen);
        assert_eq!(before.unix_timestamp, 20);
    }

    #[test]
    fn an_unfreeze_advances_the_predecessor_again() {
        let agent = Pubkey::new_unique();
        let mut cp = empty();
        cp.record(&reading(agent, false, 100, 10), 0, true);
        cp.record(&reading(agent, true, 100, 20), 0, false);
        cp.record(&reading(agent, false, 100, 30), 0, false);
        let before = cp.predecessor().expect("pinned");
        assert!(before.frozen);
        assert_eq!(before.unix_timestamp, 20);
    }
}
