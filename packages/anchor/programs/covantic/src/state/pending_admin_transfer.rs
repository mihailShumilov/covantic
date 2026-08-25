use anchor_lang::prelude::*;

/// A proposed handover of the protocol admin role, awaiting the candidate's
/// signature.
///
/// This lives in its own PDA rather than as a field on `ProtocolConfig`
/// deliberately. `ProtocolConfig` is created once at initialization and sized
/// from its struct; adding a field to it would leave the already-deployed
/// config account too small to deserialize, requiring a realloc migration
/// before the program could read its own config again. A separate account
/// that only exists while a transfer is pending has no such problem — the
/// deployed config is untouched, and the PDA is closed when the transfer
/// completes or is cancelled.
///
/// PDA: seeds = [b"covantic_pending_admin"] — one at a time, protocol-wide.
#[account]
pub struct PendingAdminTransfer {
    /// The only key that may accept this transfer.
    pub proposed_admin: Pubkey,

    /// The admin that opened it, and the account rent is refunded to when the
    /// transfer completes or is cancelled.
    pub proposed_by: Pubkey,

    /// When the proposal was made. Not enforced as an expiry — a stale
    /// proposal is visible on chain and the admin can cancel it — but it makes
    /// an abandoned handover obvious to anyone reading the account.
    pub proposed_at: i64,

    pub bump: u8,
}

impl PendingAdminTransfer {
    pub const LEN: usize = 8   // discriminator
        + 32                   // proposed_admin
        + 32                   // proposed_by
        + 8                    // proposed_at
        + 1; // bump
}
