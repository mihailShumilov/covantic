use anchor_lang::prelude::*;

/// Event: new policy created
#[event]
pub struct PolicyCreated {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub agent_address: Pubkey,
    pub coverage_amount: u64,
    pub premium_paid: u64,
    pub risk_tier: u8,
    pub start_time: i64,
    pub expiry_time: i64,
}

/// Event: claim submitted
#[event]
pub struct ClaimSubmitted {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub trigger_type: u8,
    pub submitted_at: i64,
}

/// Event: claim verified and paid out
#[event]
pub struct ClaimPaid {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub payout_amount: u64,
    pub trigger_type: u8,
    pub paid_at: i64,
}

/// Event: policy cancelled
#[event]
pub struct PolicyCancelled {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub refund_amount: u64,
}

/// Event: policy expired
#[event]
pub struct PolicyExpiredEvent {
    pub policy_id: u64,
    pub holder: Pubkey,
}

/// Event: USDC staked to the pool
#[event]
pub struct Staked {
    pub staker: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

/// Event: unstake requested
#[event]
pub struct UnstakeRequested {
    pub staker: Pubkey,
    pub amount: u64,
    pub available_at: i64,
}

/// Event: unstake executed
#[event]
pub struct Unstaked {
    pub staker: Pubkey,
    pub amount: u64,
    pub rewards: u64,
}

/// Event: staker rewards claimed
#[event]
pub struct RewardsClaimed {
    pub staker: Pubkey,
    pub amount: u64,
}

/// Event: oracle published (or refreshed) a risk attestation for an agent.
#[event]
pub struct AttestationUpserted {
    pub agent: Pubkey,
    pub tier: u8,
    pub issued_at: i64,
    pub expires_at: i64,
}

/// Event: a payout was verified against a guardian-signed price on chain.
///
/// Emitted alongside `ClaimPaid` on the proven path. Indexers can use its
/// presence to tell a payout the chain checked from one it merely permitted.
#[event]
pub struct ClaimProofVerified {
    pub policy_id: u64,
    pub feed_id: [u8; 32],
    pub reference_price: i64,
    pub executed_price: i64,
    pub deviation_bps: u32,
    pub max_provable_loss: u64,
    pub payout_amount: u64,
    pub bundle_hash: [u8; 32],
    pub price_publish_time: i64,
}

/// Event: a balance checkpoint was written for a policy.
///
/// Emitted by the permissionless crank. An indexer can use the gap between
/// consecutive events to tell whether a policy's baseline was fresh enough to
/// prove a claim against at any given moment.
#[event]
pub struct BalanceCheckpointed {
    pub policy_id: u64,
    pub covered_account: Pubkey,
    pub amount: u64,
    pub prev_amount: u64,
    pub slot: u64,
    pub unix_timestamp: i64,
}

/// Event: an exploit payout was bounded by a drop the program measured.
///
/// Emitted alongside `ClaimPaid` on the proven exploit path. Its presence is
/// what separates a payout the chain checked from one it merely permitted.
#[event]
pub struct ExploitProofVerified {
    pub policy_id: u64,
    pub covered_account: Pubkey,
    pub checkpoint_amount: u64,
    pub current_amount: u64,
    pub observed_drop: u64,
    pub drop_bps: u32,
    pub payout_amount: u64,
    pub bundle_hash: [u8; 32],
}

/// Event: a holder declared (or refreshed) the authority set for their agent.
///
/// `effective_at` is the field that matters to an observer: it is when the
/// declaration becomes usable as proof, and the gap to `declared_at` is what
/// stops a compromised key from minting a convenient baseline on demand.
#[event]
pub struct GovernanceBaselineDeclared {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub token_owner: Pubkey,
    pub extra_authority_count: u8,
    pub manifest_hash: [u8; 32],
    pub declared_at: i64,
    pub effective_at: i64,
}

/// Event: an authority checkpoint was written for a policy.
///
/// Emitted by the permissionless crank. The gap between consecutive events
/// tells an indexer whether a policy had a fresh enough reading of who was in
/// charge to prove a claim against at any given moment.
#[event]
pub struct AuthorityCheckpointed {
    pub policy_id: u64,
    pub covered_account: Pubkey,
    pub owner: Pubkey,
    pub prev_owner: Pubkey,
    pub frozen: bool,
    pub amount: u64,
    pub slot: u64,
    pub unix_timestamp: i64,
}

/// Event: a governance payout was bounded by a departure the program observed.
///
/// Emitted alongside `ClaimPaid` on the proven governance path. Its presence
/// separates a payout the chain checked from one it merely permitted.
#[event]
pub struct GovernanceProofVerified {
    pub policy_id: u64,
    pub covered_account: Pubkey,
    pub declared_owner: Pubkey,
    pub observed_owner: Pubkey,
    pub observed_frozen: bool,
    pub departure_kind: u8,
    pub departed_to: Pubkey,
    pub observed_drop: u64,
    pub seized_amount: u64,
    pub max_provable_loss: u64,
    pub payout_amount: u64,
    pub bundle_hash: [u8; 32],
}

/// Event: a holder declared (or refreshed) the operating envelope for their
/// agent.
///
/// `effective_at` is the field that matters to an observer: it is when the
/// mandate becomes usable as proof, and the gap to `declared_at` is what stops
/// a holder from declaring, after an ordinary loss, an envelope narrow enough
/// to have been breached by it.
#[event]
pub struct AgentMandateDeclared {
    pub policy_id: u64,
    pub holder: Pubkey,
    pub max_single_outflow: u64,
    pub max_window_outflow: u64,
    pub window_seconds: i64,
    pub min_retained_balance: u64,
    pub counterparty_count: u8,
    pub program_count: u8,
    pub manifest_hash: [u8; 32],
    pub declared_at: i64,
    pub effective_at: i64,
}

/// Event: an agent-error payout the program bounded against a declared
/// mandate.
///
/// Its presence — not the fact that a flag was set — is what separates a
/// payout the chain checked from one it merely permitted. `breach_excess` is
/// the bound the program derived: how far the measured drop landed outside an
/// envelope the holder signed for, and the most the payout could have been.
#[event]
pub struct AgentErrorProofVerified {
    pub policy_id: u64,
    pub covered_account: Pubkey,
    pub declared_max_single_outflow: u64,
    pub declared_min_retained_balance: u64,
    pub mandate_effective_at: i64,
    pub checkpoint_amount: u64,
    pub current_amount: u64,
    pub observed_drop: u64,
    pub breach_excess: u64,
    pub breach_kind: u8,
    pub max_provable_loss: u64,
    pub payout_amount: u64,
    pub bundle_hash: [u8; 32],
}
