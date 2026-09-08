use anchor_lang::prelude::*;

use crate::constants::{
    DEPARTURE_CLOSE_AUTHORITY, DEPARTURE_DELEGATE, DEPARTURE_FROZEN, DEPARTURE_OWNER,
    MAX_GOVERNANCE_EXTRA_AUTHORITIES,
};
use crate::state::AuthorityReading;

/// The authority set the holder declares as legitimate for their agent.
///
/// This account is what makes a governance claim provable in a way the other
/// two triggers cannot match, and the reason is worth stating plainly.
///
/// `verify_and_payout_v2` works because Pyth hands the chain a
/// guardian-signed statement about a past price. `verify_and_payout_exploit`
/// works because the program can read a balance twice and subtract. Neither
/// can establish *consent* — whether the holder meant for the money to move —
/// so both leave causation as an off-chain assertion.
///
/// Here consent is on chain. The holder signs, in advance, for who is allowed
/// to control the agent. "Was this authorised?" stops being an inference and
/// becomes a set membership test the program performs for itself.
///
/// Three properties carry the weight:
///
/// **Maturity.** `effective_at` sits `GOVERNANCE_BASELINE_DELAY` in the
/// future. A declaration that could be created and claimed against in the
/// same breath would prove nothing — a compromised holder key would simply
/// declare a fresh one. With the delay, a fraudulent claim requires
/// pre-committing on chain, an hour early, to a lie anyone can later read.
///
/// **Binding.** A declaration is only accepted while the covered account is
/// inside the set it declares. A holder cannot hand the account to an outside
/// key first and describe the agent as its rightful owner afterwards.
///
/// **Retention.** `prev_*` keeps the *whole* declaration this one replaced,
/// for the same reason `PolicyBalanceCheckpoint` does: a rotation landing
/// between the takeover and the claim must not erase the only usable
/// "before". Keeping only the previous owner, as this account once did, left
/// settlement unable to reconstruct the declaration that was actually in
/// force when the claim was filed — so a refresh before filing made a mature
/// baseline unusable, and the Active-only declaration rule made it
/// unrepairable.
#[account]
pub struct GovernanceBaseline {
    pub policy_id: u64,
    pub holder: Pubkey,

    /// Expected owner of the covered token account. Normally the agent.
    pub token_owner: Pubkey,
    /// Expected delegate. `None` for an agent that never delegates.
    pub expected_delegate: Option<Pubkey>,
    pub expected_close_authority: Option<Pubkey>,
    /// Upgrade authority of the agent's own program. **Refused when set**:
    /// the checkpoint reads a token account and cannot observe a program's
    /// authority, so a declaration naming one would present coverage the
    /// settlement path cannot adjudicate. Kept in the layout for the accounts
    /// already written.
    pub program_upgrade_authority: Option<Pubkey>,
    /// Multisig / Squads config account governing the agent. Refused when
    /// set, for the same reason.
    pub controller: Option<Pubkey>,
    /// Refused when non-zero, for the same reason.
    pub controller_min_threshold: u16,

    /// Additional addresses permitted to hold control — operator wallets, a
    /// hot key, a migration destination. Fixed-size so the account's rent and
    /// stack cost are bounded; `extra_authority_count` says how many slots
    /// are real, because the zero pubkey must never read as an allowed one.
    pub extra_authorities: [Pubkey; MAX_GOVERNANCE_EXTRA_AUTHORITIES],
    pub extra_authority_count: u8,

    /// sha256 of the off-chain manifest covering anything richer than the
    /// fields above. Committed, not interpreted: the chain checks what it can
    /// read and leaves the rest permanently falsifiable.
    pub manifest_hash: [u8; 32],

    pub declared_at: i64,
    /// When this declaration becomes usable as proof.
    pub effective_at: i64,

    /// The declaration this one replaced.
    pub prev_token_owner: Pubkey,
    pub prev_effective_at: i64,

    pub bump: u8,

    // ---- appended after `bump`, on purpose ------------------------------
    // Baselines written before these fields existed end at `bump`. Inserting
    // above it would shift `bump` for every one of them; appended, an account
    // grown by `migrate_governance_baseline` reads them as zero, which the
    // predecessor view treats as "nothing declared" for that field.
    /// The rest of the replaced declaration, so it can be reconstructed
    /// whole at settlement.
    pub prev_expected_delegate: Option<Pubkey>,
    pub prev_expected_close_authority: Option<Pubkey>,
    pub prev_extra_authorities: [Pubkey; MAX_GOVERNANCE_EXTRA_AUTHORITIES],
    pub prev_extra_authority_count: u8,
    pub prev_manifest_hash: [u8; 32],
    pub prev_declared_at: i64,
}

/// One complete declaration — the current one or the one it replaced — as
/// the settlement path evaluates it.
#[derive(Clone, Copy, Debug)]
pub struct BaselineView {
    pub token_owner: Pubkey,
    pub expected_delegate: Option<Pubkey>,
    pub expected_close_authority: Option<Pubkey>,
    pub extra_authorities: [Pubkey; MAX_GOVERNANCE_EXTRA_AUTHORITIES],
    pub extra_authority_count: u8,
    pub manifest_hash: [u8; 32],
    pub declared_at: i64,
    pub effective_at: i64,
}

impl BaselineView {
    /// Is `candidate` permitted to hold `role`?
    ///
    /// Keyed by role on purpose. The declaration names distinct capabilities,
    /// and asking only "does this address appear anywhere in the
    /// declaration?" says that declaring an address for any one of them
    /// declares it for all.
    ///
    /// That is exploitable, not merely imprecise: this account is public, so
    /// an attacker who can issue `SetAuthority(AccountOwner)` reads the
    /// declared *delegate* and names it as the new *owner*. Under a flat test
    /// the seizure lands inside the declared set and `classify_departure`
    /// finds no departure to settle.
    ///
    /// `extra_authorities` are the deliberate exception — operator keys the
    /// holder declared without binding them to a role, so they satisfy any
    /// *declared* role. A role outside the taxonomy is refused outright, before
    /// the wildcard is consulted: "not a role we know" must never resolve to
    /// "permitted, because an operator was declared".
    ///
    /// The agent and the holder are *not* folded in here. Callers add them
    /// explicitly, because the two questions — "is this declared?" and "is
    /// this still the family?" — produce different rejection reasons and
    /// collapsing them would lose that.
    pub fn permits_role(&self, candidate: &Pubkey, role: u8) -> bool {
        let named_match = match role {
            DEPARTURE_OWNER | DEPARTURE_FROZEN => candidate == &self.token_owner,
            DEPARTURE_DELEGATE => self.expected_delegate == Some(*candidate),
            DEPARTURE_CLOSE_AUTHORITY => self.expected_close_authority == Some(*candidate),
            _ => return false,
        };
        if named_match {
            return true;
        }
        let count = (self.extra_authority_count as usize).min(MAX_GOVERNANCE_EXTRA_AUTHORITIES);
        self.extra_authorities[..count].contains(candidate)
    }

    /// Is every control field of `reading` inside this declaration, with the
    /// agent and holder folded in as the family that is always permitted?
    ///
    /// This is the definition of "before": a checkpointed reading the
    /// settlement path may treat as the permitted state a departure moved
    /// away from. A frozen account is never inside the declared set — the
    /// holder declares who may control the agent, not that it may be stopped.
    pub fn covers(&self, reading: &AuthorityReading, holder: &Pubkey, agent: &Pubkey) -> bool {
        let permitted = |candidate: &Pubkey, role: u8| -> bool {
            candidate == holder || candidate == agent || self.permits_role(candidate, role)
        };
        if reading.frozen {
            return false;
        }
        if !permitted(&reading.owner, DEPARTURE_OWNER) {
            return false;
        }
        if let Some(delegate) = reading.delegate {
            if !permitted(&delegate, DEPARTURE_DELEGATE) {
                return false;
            }
        }
        if let Some(close_authority) = reading.close_authority {
            if !permitted(&close_authority, DEPARTURE_CLOSE_AUTHORITY) {
                return false;
            }
        }
        true
    }
}

impl GovernanceBaseline {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // holder
        + 32                   // token_owner
        + 33                   // expected_delegate
        + 33                   // expected_close_authority
        + 33                   // program_upgrade_authority
        + 33                   // controller
        + 2                    // controller_min_threshold
        + 32 * MAX_GOVERNANCE_EXTRA_AUTHORITIES
        + 1                    // extra_authority_count
        + 32                   // manifest_hash
        + 8                    // declared_at
        + 8                    // effective_at
        + 32                   // prev_token_owner
        + 8                    // prev_effective_at
        + 1                    // bump
        + 33                   // prev_expected_delegate
        + 33                   // prev_expected_close_authority
        + 32 * MAX_GOVERNANCE_EXTRA_AUTHORITIES
        + 1                    // prev_extra_authority_count
        + 32                   // prev_manifest_hash
        + 8; // prev_declared_at

    /// The declaration as currently written.
    pub fn current_view(&self) -> BaselineView {
        BaselineView {
            token_owner: self.token_owner,
            expected_delegate: self.expected_delegate,
            expected_close_authority: self.expected_close_authority,
            extra_authorities: self.extra_authorities,
            extra_authority_count: self.extra_authority_count,
            manifest_hash: self.manifest_hash,
            declared_at: self.declared_at,
            effective_at: self.effective_at,
        }
    }

    /// The declaration this one replaced, if there was one.
    pub fn predecessor_view(&self) -> Option<BaselineView> {
        if self.prev_effective_at == 0 {
            return None;
        }
        Some(BaselineView {
            token_owner: self.prev_token_owner,
            expected_delegate: self.prev_expected_delegate,
            expected_close_authority: self.prev_expected_close_authority,
            extra_authorities: self.prev_extra_authorities,
            extra_authority_count: self.prev_extra_authority_count,
            manifest_hash: self.prev_manifest_hash,
            declared_at: self.prev_declared_at,
            effective_at: self.prev_effective_at,
        })
    }

    /// The declaration that was in force at `at`.
    ///
    /// The current one if it had matured by then; otherwise the one it
    /// replaced, if *that* had. A refresh landing after the incident but
    /// before the claim describes the aftermath, and must not make the
    /// declaration that actually governed the incident disappear.
    pub fn view_at(&self, at: i64) -> Option<BaselineView> {
        if self.effective_at > 0 && self.effective_at <= at {
            return Some(self.current_view());
        }
        self.predecessor_view()
            .filter(|prev| prev.effective_at > 0 && prev.effective_at <= at)
    }

    /// Convenience over the current declaration. See `BaselineView`.
    pub fn permits_role(&self, candidate: &Pubkey, role: u8) -> bool {
        self.current_view().permits_role(candidate, role)
    }

    /// Copy the current declaration into `prev_*` ahead of a refresh.
    pub fn retain_as_predecessor(&mut self) {
        self.prev_token_owner = self.token_owner;
        self.prev_expected_delegate = self.expected_delegate;
        self.prev_expected_close_authority = self.expected_close_authority;
        self.prev_extra_authorities = self.extra_authorities;
        self.prev_extra_authority_count = self.extra_authority_count;
        self.prev_manifest_hash = self.manifest_hash;
        self.prev_declared_at = self.declared_at;
        self.prev_effective_at = self.effective_at;
    }

    /// Record that there is no predecessor. A first declaration must say so:
    /// any `prev`-based fallback would otherwise accept the declaration as
    /// matured the instant it was written.
    pub fn clear_predecessor(&mut self) {
        self.prev_token_owner = Pubkey::default();
        self.prev_expected_delegate = None;
        self.prev_expected_close_authority = None;
        self.prev_extra_authorities = [Pubkey::default(); MAX_GOVERNANCE_EXTRA_AUTHORITIES];
        self.prev_extra_authority_count = 0;
        self.prev_manifest_hash = [0u8; 32];
        self.prev_declared_at = 0;
        self.prev_effective_at = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{DEPARTURE_CONTROLLER, DEPARTURE_UPGRADE_AUTHORITY};

    fn key(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn view(delegate: Option<Pubkey>, extras: &[Pubkey]) -> BaselineView {
        let mut extra_authorities = [Pubkey::default(); MAX_GOVERNANCE_EXTRA_AUTHORITIES];
        for (slot, k) in extras.iter().enumerate() {
            extra_authorities[slot] = *k;
        }
        BaselineView {
            token_owner: key(1),
            expected_delegate: delegate,
            expected_close_authority: None,
            extra_authorities,
            extra_authority_count: extras.len() as u8,
            manifest_hash: [0u8; 32],
            declared_at: 100,
            effective_at: 3_700,
        }
    }

    fn reading(owner: Pubkey, delegate: Option<Pubkey>, frozen: bool) -> AuthorityReading {
        AuthorityReading {
            owner,
            delegate,
            close_authority: None,
            frozen,
            amount: 1,
            slot: 1,
            unix_timestamp: 1,
        }
    }

    #[test]
    fn roles_are_distinct() {
        let v = view(Some(key(2)), &[]);
        assert!(v.permits_role(&key(1), DEPARTURE_OWNER));
        assert!(v.permits_role(&key(2), DEPARTURE_DELEGATE));
        // A declared delegate is not thereby permitted to become the owner.
        assert!(!v.permits_role(&key(2), DEPARTURE_OWNER));
    }

    #[test]
    fn extras_satisfy_any_declared_role() {
        let v = view(None, &[key(9)]);
        assert!(v.permits_role(&key(9), DEPARTURE_OWNER));
        assert!(v.permits_role(&key(9), DEPARTURE_DELEGATE));
        assert!(v.permits_role(&key(9), DEPARTURE_CLOSE_AUTHORITY));
    }

    #[test]
    fn an_unknown_role_is_refused_before_the_wildcard() {
        let v = view(None, &[key(9)]);
        for role in [
            0u8,
            7,
            255,
            DEPARTURE_UPGRADE_AUTHORITY,
            DEPARTURE_CONTROLLER,
        ] {
            assert!(
                !v.permits_role(&key(9), role),
                "role {role} must not be wildcarded"
            );
            assert!(!v.permits_role(&key(1), role));
        }
    }

    #[test]
    fn the_zero_key_is_never_permitted_by_an_unset_slot() {
        let v = view(None, &[]);
        assert!(!v.permits_role(&Pubkey::default(), DEPARTURE_OWNER));
        assert!(!v.permits_role(&Pubkey::default(), DEPARTURE_DELEGATE));
    }

    #[test]
    fn covers_requires_every_field_inside_the_set() {
        let holder = key(50);
        let agent = key(1);
        let v = view(None, &[key(9)]);
        assert!(v.covers(&reading(agent, None, false), &holder, &agent));
        assert!(v.covers(&reading(key(9), None, false), &holder, &agent));
        assert!(v.covers(&reading(holder, None, false), &holder, &agent));
        // An undeclared delegate, a foreign owner, or a freeze all fall
        // outside.
        assert!(!v.covers(&reading(agent, Some(key(3)), false), &holder, &agent));
        assert!(!v.covers(&reading(key(3), None, false), &holder, &agent));
        assert!(!v.covers(&reading(agent, None, true), &holder, &agent));
    }

    fn baseline() -> GovernanceBaseline {
        GovernanceBaseline {
            policy_id: 1,
            holder: key(50),
            token_owner: key(1),
            expected_delegate: None,
            expected_close_authority: None,
            program_upgrade_authority: None,
            controller: None,
            controller_min_threshold: 0,
            extra_authorities: [Pubkey::default(); MAX_GOVERNANCE_EXTRA_AUTHORITIES],
            extra_authority_count: 0,
            manifest_hash: [1u8; 32],
            declared_at: 100,
            effective_at: 3_700,
            prev_token_owner: Pubkey::default(),
            prev_effective_at: 0,
            bump: 0,
            prev_expected_delegate: None,
            prev_expected_close_authority: None,
            prev_extra_authorities: [Pubkey::default(); MAX_GOVERNANCE_EXTRA_AUTHORITIES],
            prev_extra_authority_count: 0,
            prev_manifest_hash: [0u8; 32],
            prev_declared_at: 0,
        }
    }

    #[test]
    fn a_first_declaration_has_no_view_before_it_matures() {
        let b = baseline();
        assert!(b.view_at(3_699).is_none());
        assert!(b.view_at(3_700).is_some());
    }

    #[test]
    fn a_refresh_keeps_the_whole_predecessor_usable() {
        let mut b = baseline();
        let mut extras = [Pubkey::default(); MAX_GOVERNANCE_EXTRA_AUTHORITIES];
        extras[0] = key(9);
        b.extra_authorities = extras;
        b.extra_authority_count = 1;

        // Refresh at t=10_000, matures at 13_600.
        b.retain_as_predecessor();
        b.token_owner = key(2);
        b.extra_authorities = [Pubkey::default(); MAX_GOVERNANCE_EXTRA_AUTHORITIES];
        b.extra_authority_count = 0;
        b.manifest_hash = [2u8; 32];
        b.declared_at = 10_000;
        b.effective_at = 13_600;

        // A claim filed while the refresh is immature is judged against the
        // declaration that was in force — extras and all.
        let in_force = b.view_at(12_000).expect("predecessor in force");
        assert_eq!(in_force.token_owner, key(1));
        assert!(in_force.permits_role(&key(9), DEPARTURE_OWNER));
        assert_eq!(in_force.manifest_hash, [1u8; 32]);

        // Once the refresh matures, it takes over.
        let after = b.view_at(13_600).expect("current in force");
        assert_eq!(after.token_owner, key(2));
        assert!(!after.permits_role(&key(9), DEPARTURE_OWNER));
    }
}
