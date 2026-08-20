use anchor_lang::prelude::*;

use crate::constants::{
    DEPARTURE_CLOSE_AUTHORITY, DEPARTURE_CONTROLLER, DEPARTURE_DELEGATE, DEPARTURE_FROZEN,
    DEPARTURE_OWNER, DEPARTURE_UPGRADE_AUTHORITY, MAX_GOVERNANCE_EXTRA_AUTHORITIES,
};

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
/// Two properties carry the weight:
///
/// **Maturity.** `effective_at` sits `GOVERNANCE_BASELINE_DELAY` in the
/// future. A declaration that could be created and claimed against in the
/// same breath would prove nothing — a compromised holder key would simply
/// declare a fresh one. With the delay, a fraudulent claim requires
/// pre-committing on chain, an hour early, to a lie anyone can later read.
///
/// **Retention.** `prev_*` keeps the declaration this one replaced, for the
/// same reason `PolicyBalanceCheckpoint` does: a rotation landing between the
/// takeover and the claim must not erase the only usable "before".
#[account]
pub struct GovernanceBaseline {
    pub policy_id: u64,
    pub holder: Pubkey,

    /// Expected owner of the covered token account. Normally the agent.
    pub token_owner: Pubkey,
    /// Expected delegate. `None` for an agent that never delegates.
    pub expected_delegate: Option<Pubkey>,
    pub expected_close_authority: Option<Pubkey>,
    /// Upgrade authority of the agent's own program, when it runs one.
    pub program_upgrade_authority: Option<Pubkey>,
    /// Multisig / Squads config account governing the agent.
    pub controller: Option<Pubkey>,
    /// Threshold that config must not fall below. Recorded rather than
    /// enforced: the program cannot decode a Squads config, and pretending
    /// otherwise would be worse than committing to the number and leaving the
    /// check to a reader who can.
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
        + 1; // bump

    /// Is `candidate` permitted to hold `role`?
    ///
    /// Keyed by role on purpose. The declaration names five distinct
    /// capabilities, and asking only "does this address appear anywhere in the
    /// declaration?" says that declaring an address for any one of them
    /// declares it for all five.
    ///
    /// That is exploitable, not merely imprecise: this account is public, so
    /// an attacker who can issue `SetAuthority(AccountOwner)` reads the
    /// declared *delegate* and names it as the new *owner*. Under a flat test
    /// the seizure lands inside the declared set and `classify_departure`
    /// finds no departure to settle.
    ///
    /// `extra_authorities` are the deliberate exception — operator keys the
    /// holder declared without binding them to a role, so they satisfy any.
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
            DEPARTURE_UPGRADE_AUTHORITY => self.program_upgrade_authority == Some(*candidate),
            DEPARTURE_CONTROLLER => self.controller == Some(*candidate),
            _ => false,
        };
        if named_match {
            return true;
        }
        let count = (self.extra_authority_count as usize).min(MAX_GOVERNANCE_EXTRA_AUTHORITIES);
        self.extra_authorities[..count].contains(candidate)
    }
}
