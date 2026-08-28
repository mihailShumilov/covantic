use anchor_lang::prelude::*;

/// The "before" a drain is measured against, read by the program itself.
///
/// This account is the exploit path's answer to the problem that makes it
/// different from the price path. `verify_and_payout_v2` works because Pyth
/// hands the chain a guardian-signed statement about the past. There is no
/// equivalent for "account X held N at slot S" — no signed-history oracle for
/// balances, and `SlotHashes` reaches back minutes, far short of a one-hour
/// lock. So the chain cannot be *told* what the balance was.
///
/// It can, however, *read* it. A permissionless crank calls
/// `checkpoint_covered_balance`, which reads the agent's covered token
/// account — an account Anchor constrains to be the right one — and records
/// what it saw. At payout the program reads the same account again and
/// subtracts. Nobody asserts either number.
///
/// `prev_*` is retained so a checkpoint that was itself written after the
/// incident does not erase the only usable baseline.
#[account]
pub struct PolicyBalanceCheckpoint {
    pub policy_id: u64,
    /// Token account the balance was read from. Recorded so a reader can
    /// confirm the payout was bounded against the account it claims.
    pub covered_account: Pubkey,

    pub amount: u64,
    pub slot: u64,
    pub unix_timestamp: i64,

    /// The reading this one replaced.
    pub prev_amount: u64,
    pub prev_slot: u64,
    pub prev_unix_timestamp: i64,

    pub bump: u8,
}

impl PolicyBalanceCheckpoint {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // covered_account
        + 8                    // amount
        + 8                    // slot
        + 8                    // unix_timestamp
        + 8                    // prev_amount
        + 8                    // prev_slot
        + 8                    // prev_unix_timestamp
        + 1; // bump
}

/// On-chain record of an exploit payout the program bounded itself.
///
/// The counterpart to `ClaimEvidenceRecord` on the price path, and it records
/// the same kind of thing: the numbers the *program* derived, not the ones it
/// was handed. `observed_drop` is a subtraction this program performed
/// between two balances it read from a constrained account, so anyone can
/// recompute the bound from the two checkpoints and the payout.
#[account]
pub struct ExploitEvidenceRecord {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub covered_account: Pubkey,

    /// Balance at the checkpoint, read by the program.
    pub checkpoint_amount: u64,
    pub checkpoint_slot: u64,
    pub checkpoint_unix_timestamp: i64,

    /// Balance at payout, read by the program.
    pub current_amount: u64,

    /// `checkpoint_amount - current_amount`, computed here.
    pub observed_drop: u64,
    /// The drop as a fraction of the checkpoint, in basis points.
    pub drop_bps: u32,
    pub payout_amount: u64,

    /// sha256 of the canonical off-chain evidence bundle. The chain proves
    /// the money left; this commits to the claim about *why*.
    pub bundle_hash: [u8; 32],
    pub verified_at: i64,
    pub bump: u8,
}

impl ExploitEvidenceRecord {
    pub const LEN: usize = 8   // discriminator
        + 8                    // policy_id
        + 32                   // holder
        + 32                   // covered_account
        + 8                    // checkpoint_amount
        + 8                    // checkpoint_slot
        + 8                    // checkpoint_unix_timestamp
        + 8                    // current_amount
        + 8                    // observed_drop
        + 4                    // drop_bps
        + 8                    // payout_amount
        + 32                   // bundle_hash
        + 8                    // verified_at
        + 1; // bump
}
