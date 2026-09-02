use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL");

/// Covantic — AI Agent Insurance Protocol on Solana.
/// Parametric insurance for AI agents performing DeFi operations.
#[program]
pub mod covantic {
    use super::*;

    /// Initialize protocol: creates config + vault.
    /// Called ONCE at deployment.
    pub fn initialize(ctx: Context<Initialize>, oracle_authority: Pubkey) -> Result<()> {
        initialize_handler(ctx, oracle_authority)
    }

    /// Create an insurance policy.
    /// Holder pays premium, receives a Policy PDA. The risk tier comes from
    /// the oracle-signed RiskAttestation PDA for the agent — buyers cannot
    /// self-select a tier.
    pub fn create_policy(
        ctx: Context<CreatePolicy>,
        coverage_amount: u64,
        duration_seconds: i64,
        agent_address: Pubkey,
        mandate: AgentMandate,
    ) -> Result<()> {
        create_policy_handler(ctx, coverage_amount, duration_seconds, agent_address, mandate)
    }

    /// Publish (or refresh) a risk attestation for an agent. Only the oracle
    /// authority may sign. `create_policy` requires a live attestation.
    pub fn upsert_attestation(
        ctx: Context<UpsertAttestation>,
        agent: Pubkey,
        tier: u8,
        valid_for_seconds: i64,
        mandate_hash: [u8; 32],
        envelope_surcharge_bps: u16,
    ) -> Result<()> {
        upsert_attestation_handler(
            ctx,
            agent,
            tier,
            valid_for_seconds,
            mandate_hash,
            envelope_surcharge_bps,
        )
    }

    /// Cancel a policy with partial refund.
    pub fn cancel_policy(ctx: Context<CancelPolicy>) -> Result<()> {
        cancel_policy_handler(ctx)
    }

    /// Submit an insurance claim (holder-signed path, used by SDK/agent flow).
    pub fn submit_claim(
        ctx: Context<SubmitClaim>,
        trigger_type: u8,
        trigger_tx_signature: Vec<u8>,
    ) -> Result<()> {
        submit_claim_handler(ctx, trigger_type, trigger_tx_signature)
    }

    /// Submit an insurance claim on behalf of a holder (oracle-signed path,
    /// used by the automated monitoring pipeline). Only the oracle authority
    /// configured in ProtocolConfig may call this.
    pub fn oracle_submit_claim(
        ctx: Context<OracleSubmitClaim>,
        trigger_type: u8,
        trigger_tx_signature: Vec<u8>,
    ) -> Result<()> {
        oracle_submit_claim_handler(ctx, trigger_type, trigger_tx_signature)
    }

    /// Verify a claim and execute payout (oracle only).
    pub fn verify_and_payout(ctx: Context<VerifyAndPayout>, payout_amount: u64) -> Result<()> {
        verify_and_payout_handler(ctx, payout_amount)
    }

    /// Verify an oracle-manipulation claim against a guardian-signed Pyth
    /// price and execute payout.
    ///
    /// Prefer this over `verify_and_payout` for TRIGGER_ORACLE_MANIPULATION.
    /// The program checks the reference price itself instead of trusting the
    /// oracle's word for it, and records what it verified in a
    /// `ClaimEvidenceRecord` PDA so the payout stays auditable afterwards.
    pub fn verify_and_payout_v2(
        ctx: Context<VerifyAndPayoutV2>,
        payout_amount: u64,
        evidence: PayoutEvidence,
    ) -> Result<()> {
        verify_and_payout_v2_handler(ctx, payout_amount, evidence)
    }

    /// Record the covered account's balance as the baseline a later exploit
    /// payout is bounded by (permissionless crank).
    ///
    /// Permissionless on purpose: a baseline only the oracle could write
    /// would put the oracle back in charge of the very number that is
    /// supposed to constrain it.
    pub fn checkpoint_balance(ctx: Context<CheckpointBalance>) -> Result<()> {
        checkpoint_balance_handler(ctx)
    }

    /// Verify an exploit claim against a balance drop the program measures
    /// for itself, and execute payout.
    ///
    /// Prefer this over `verify_and_payout` for TRIGGER_EXPLOIT. The program
    /// re-reads the covered token account and refuses to pay more than the
    /// difference from its own earlier checkpoint, so the oracle cannot
    /// assert a loss that did not happen. What it still asserts — that the
    /// drop was an exploit rather than the holder moving funds — is committed
    /// via `bundle_hash` and left publicly falsifiable.
    pub fn verify_and_payout_exploit(
        ctx: Context<VerifyAndPayoutExploit>,
        payout_amount: u64,
        evidence: ExploitPayoutEvidence,
    ) -> Result<()> {
        verify_and_payout_exploit_handler(ctx, payout_amount, evidence)
    }

    /// Declare (or refresh) the authority set that is legitimate for an
    /// agent. Holder-signed, and it matures on a delay — a baseline that
    /// could be written and claimed against in the same breath would prove
    /// nothing.
    pub fn declare_governance_baseline(
        ctx: Context<DeclareGovernanceBaseline>,
        manifest: GovernanceManifest,
    ) -> Result<()> {
        declare_governance_baseline_handler(ctx, manifest)
    }

    /// Record who controls the covered account (permissionless crank).
    ///
    /// The governance counterpart to `checkpoint_balance`, and it must exist
    /// separately: a balance reading is blind to a seizure, where the tokens
    /// never move and only the owner changes, and to a freeze, where nothing
    /// changes at all except that the agent can no longer act.
    pub fn checkpoint_authority(ctx: Context<CheckpointAuthority>) -> Result<()> {
        checkpoint_authority_handler(ctx)
    }

    /// Verify a governance claim against a departure the program observes,
    /// and execute payout.
    ///
    /// The only path where the chain establishes the covered *event* rather
    /// than merely bounding its size: it compares the holder's own matured
    /// declaration of who may control the agent against what it reads on the
    /// account now. The oracle asserts neither side.
    pub fn verify_and_payout_governance(
        ctx: Context<VerifyAndPayoutGovernance>,
        payout_amount: u64,
        evidence: GovernancePayoutEvidence,
    ) -> Result<()> {
        verify_and_payout_governance_handler(ctx, payout_amount, evidence)
    }

    /// Declare (or refresh) the operating envelope that is legitimate for an
    /// agent. Holder-signed, and it matures on a delay for the same reason
    /// the governance baseline does — a mandate that could be written and
    /// claimed against in the same breath would prove nothing.
    ///
    /// This is what makes an agent-error claim provable at all. The trigger
    /// covers a loss the agent caused with its *own* authority, so there is
    /// no unauthorised signer to point at and no change of control to
    /// observe; without the holder saying in advance what the agent was
    /// permitted to do, the chain has nothing to check.
    pub fn declare_agent_mandate(
        ctx: Context<DeclareAgentMandate>,
        mandate: AgentMandate,
    ) -> Result<()> {
        declare_agent_mandate_handler(ctx, mandate)
    }

    /// Verify an agent-error claim against the holder's declared mandate and
    /// a balance drop the program measures, and execute payout.
    ///
    /// Prefer this over `verify_and_payout` for TRIGGER_AGENT_ERROR. The
    /// program re-reads the covered token account, compares the drop against
    /// an envelope the holder signed for before the claim was filed, and
    /// refuses to pay more than the overshoot. It settles only breaches it
    /// can measure: a movement to an undeclared destination produces no
    /// overshoot and goes to a reviewer rather than being paid on the
    /// oracle's word.
    pub fn verify_and_payout_agent_error(
        ctx: Context<VerifyAndPayoutAgentError>,
        payout_amount: u64,
        evidence: AgentErrorPayoutEvidence,
    ) -> Result<()> {
        verify_and_payout_agent_error_handler(ctx, payout_amount, evidence)
    }

    /// Mark expired policies (permissionless crank).
    pub fn expire_policy(ctx: Context<ExpirePolicy>) -> Result<()> {
        expire_policy_handler(ctx)
    }

    /// Stake USDC into the insurance pool.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        stake_handler(ctx, amount)
    }

    /// Request unstake (starts 48h cooldown).
    pub fn request_unstake(ctx: Context<RequestUnstake>) -> Result<()> {
        request_unstake_handler(ctx)
    }

    /// Execute unstake after cooldown.
    pub fn execute_unstake(ctx: Context<ExecuteUnstake>) -> Result<()> {
        execute_unstake_handler(ctx)
    }

    /// Claim accumulated staker rewards.
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        claim_rewards_handler(ctx)
    }

    /// Admin-only: rotate admin / oracle authority, toggle pause, adjust
    /// the solvency-based premium multiplier. Each argument is optional.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_oracle_authority: Option<Pubkey>,
        new_paused: Option<bool>,
        new_premium_multiplier_bps: Option<u16>,
    ) -> Result<()> {
        update_config_handler(
            ctx,
            new_oracle_authority,
            new_paused,
            new_premium_multiplier_bps,
        )
    }

    /// Propose a new protocol admin. Takes effect only once the candidate
    /// calls `accept_admin`, so a mistyped key cannot capture the one role
    /// that can pause the protocol and rotate the oracle authority.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        propose_admin_handler(ctx, new_admin)
    }

    /// Accept a pending admin transfer. Signed by the proposed admin.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        accept_admin_handler(ctx)
    }

    /// Grow the vault account to the current layout and seed `loss_index`.
    /// Idempotent; required once after the loss-socialisation upgrade.
    pub fn migrate_vault(ctx: Context<MigrateVault>) -> Result<()> {
        migrate_vault_handler(ctx)
    }

    /// Grow a staker position to the current layout. Permissionless and
    /// idempotent; required once per position after the same upgrade.
    pub fn migrate_staker_position(ctx: Context<MigrateStakerPosition>) -> Result<()> {
        migrate_staker_position_handler(ctx)
    }

    /// Grow a risk attestation to the current layout. Permissionless and
    /// idempotent; required once per agent that was quoted before the envelope
    /// was priced, or `upsert_attestation` cannot read the account it needs to
    /// overwrite.
    pub fn migrate_attestation(ctx: Context<MigrateAttestation>) -> Result<()> {
        migrate_attestation_handler(ctx)
    }

    /// Withdraw a pending admin transfer.
    pub fn cancel_admin_transfer(ctx: Context<CancelAdminTransfer>) -> Result<()> {
        cancel_admin_transfer_handler(ctx)
    }
}
