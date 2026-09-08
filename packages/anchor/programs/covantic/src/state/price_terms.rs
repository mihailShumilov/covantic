use anchor_lang::prelude::*;

use crate::constants::MAX_SUBJECT_DECIMALS;
use crate::errors::CovanticError;

/// The asset an oracle-manipulation claim on a policy may be priced against,
/// fixed at purchase and never changed.
///
/// `verify_and_payout_v2` proves a *price*: it reads a guardian-signed Pyth
/// update and refuses to pay more than the deviation from it can account for.
/// What it could not do before this account existed was say which price. The
/// feed, the quantity and the decimals all arrived in the oracle's evidence
/// and were checked only against each other, so a compromised oracle key could
/// pick any genuine feed that happened to have moved, assert a position in it,
/// and produce a loss bound that reached the coverage — for an asset the agent
/// never held.
///
/// The terms are attested by the oracle *before* the purchase, in the same
/// `RiskAttestation` that fixes the tier and prices the envelope, and copied
/// here by `create_policy`. A holder cannot choose them and the oracle cannot
/// change them afterwards. At settlement the evidence must name this feed,
/// this many decimals, and a quantity no larger than the bound recorded here.
///
/// A policy whose attestation carried no terms (`feed_id` all zero) is not
/// covered for oracle manipulation on the proof path: the instruction refuses
/// it, and the claim goes to a reviewer.
///
/// Kept in its own PDA rather than as new fields on `InsurancePolicy`, for the
/// reason `ClaimEvidenceRecord` gives: growing a live account type forces a
/// migration of every policy already on chain.
#[account]
pub struct PolicyPriceTerms {
    pub policy_id: u64,
    pub holder: Pubkey,

    /// Pyth feed the reference price must come from. All zero when the policy
    /// carries no oracle-manipulation terms.
    pub feed_id: [u8; 32],
    /// The asset that feed prices, so a reader can tie the feed to a mint.
    pub subject_mint: Pubkey,
    /// Decimals the evidence must scale the subject quantity with.
    pub subject_decimals: u8,
    /// Largest subject quantity a claim may assert, in the subject's base
    /// units. Bounds what the oracle can multiply a deviation by.
    pub max_subject_quantity: u64,

    pub bump: u8,
}

impl PolicyPriceTerms {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // holder
        + 32                   // feed_id
        + 32                   // subject_mint
        + 1                    // subject_decimals
        + 8                    // max_subject_quantity
        + 1; // bump

    /// Whether the policy carries terms a price claim can be settled against.
    pub fn is_priced(&self) -> bool {
        self.feed_id != [0u8; 32]
    }
}

/// The price terms as the oracle attests them.
///
/// Either wholly absent — every field zero, meaning the oracle priced no
/// oracle-manipulation cover for this agent — or wholly present. A partial
/// declaration is refused rather than interpreted.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AttestedPriceTerms {
    pub feed_id: [u8; 32],
    pub subject_mint: Pubkey,
    pub subject_decimals: u8,
    pub max_subject_quantity: u64,
}

impl AttestedPriceTerms {
    pub fn is_empty(&self) -> bool {
        self.feed_id == [0u8; 32]
            && self.subject_mint == Pubkey::default()
            && self.subject_decimals == 0
            && self.max_subject_quantity == 0
    }

    pub fn validate(&self) -> Result<()> {
        if self.is_empty() {
            return Ok(());
        }
        require!(self.feed_id != [0u8; 32], CovanticError::InvalidPriceTerms);
        require!(
            self.subject_mint != Pubkey::default(),
            CovanticError::InvalidPriceTerms
        );
        require!(
            self.subject_decimals <= MAX_SUBJECT_DECIMALS,
            CovanticError::InvalidPriceTerms
        );
        require!(
            self.max_subject_quantity > 0,
            CovanticError::InvalidPriceTerms
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_terms_are_valid_and_unpriced() {
        let terms = AttestedPriceTerms::default();
        assert!(terms.is_empty());
        assert!(terms.validate().is_ok());
    }

    #[test]
    fn a_partial_declaration_is_refused() {
        let terms = AttestedPriceTerms {
            feed_id: [1u8; 32],
            ..Default::default()
        };
        assert!(terms.validate().is_err());
    }

    #[test]
    fn a_full_declaration_is_accepted() {
        let terms = AttestedPriceTerms {
            feed_id: [1u8; 32],
            subject_mint: Pubkey::new_unique(),
            subject_decimals: 9,
            max_subject_quantity: 1_000,
        };
        assert!(!terms.is_empty());
        assert!(terms.validate().is_ok());
    }

    #[test]
    fn decimals_are_bounded() {
        let terms = AttestedPriceTerms {
            feed_id: [1u8; 32],
            subject_mint: Pubkey::new_unique(),
            subject_decimals: MAX_SUBJECT_DECIMALS + 1,
            max_subject_quantity: 1,
        };
        assert!(terms.validate().is_err());
    }
}
