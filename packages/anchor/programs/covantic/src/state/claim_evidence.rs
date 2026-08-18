use anchor_lang::prelude::*;

/// On-chain record of the evidence a payout was verified against.
///
/// Written by `verify_and_payout_v2` after the program has checked the price
/// itself. It exists so a payout can be audited by someone who does not trust
/// the oracle backend: the reference price recorded here came out of a
/// guardian-signed Pyth update that this program verified, and `bundle_hash`
/// commits to the full off-chain evidence, which is published separately. A
/// bundle that does not hash to this value is provably not the one the
/// payout was made on.
///
/// Kept in its own PDA rather than as new fields on `InsurancePolicy`,
/// because growing a live account type would force a realloc of every policy
/// already on chain.
#[account]
pub struct ClaimEvidenceRecord {
    /// Policy this evidence belongs to.
    pub policy_id: u64,
    pub holder: Pubkey,

    /// Pyth feed the reference price came from.
    pub feed_id: [u8; 32],
    /// Exponent shared by `reference_price` and `executed_price`.
    pub expo: i32,
    /// Price the guardians signed, as published.
    pub reference_price: i64,
    /// Price the transaction actually executed at, committed by the oracle.
    pub executed_price: i64,
    /// Quantity of the subject asset, in its own base units.
    pub subject_quantity: u64,
    pub subject_decimals: u8,

    /// When the reference price was published.
    pub price_publish_time: i64,
    /// Block time of the trigger transaction, committed by the oracle.
    pub trigger_block_time: i64,

    /// Deviation the program recomputed, in basis points.
    pub deviation_bps: u32,
    /// Upper bound on the loss the signed price can support.
    pub max_provable_loss: u64,
    pub payout_amount: u64,

    /// sha256 of the canonical off-chain evidence bundle.
    pub bundle_hash: [u8; 32],
    pub verified_at: i64,
    pub bump: u8,
}

impl ClaimEvidenceRecord {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // holder
        + 32                   // feed_id
        + 4                    // expo
        + 8                    // reference_price
        + 8                    // executed_price
        + 8                    // subject_quantity
        + 1                    // subject_decimals
        + 8                    // price_publish_time
        + 8                    // trigger_block_time
        + 4                    // deviation_bps
        + 8                    // max_provable_loss
        + 8                    // payout_amount
        + 32                   // bundle_hash
        + 8                    // verified_at
        + 1; // bump
}
