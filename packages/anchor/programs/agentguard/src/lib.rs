use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("52KrSMg3rsbtRw3FchxJ9jRwRzQmWcDzg1AiiHHHXz1D");

/// AgentGuard — AI Agent Insurance Protocol on Solana.
/// Parametric insurance for AI agents performing DeFi operations.
#[program]
pub mod agentguard {
    use super::*;

    /// Initialize protocol: creates config + vault.
    /// Called ONCE at deployment.
    pub fn initialize(ctx: Context<Initialize>, oracle_authority: Pubkey) -> Result<()> {
        initialize_handler(ctx, oracle_authority)
    }

    /// Create an insurance policy.
    /// Holder pays premium, receives a Policy PDA.
    pub fn create_policy(
        ctx: Context<CreatePolicy>,
        coverage_amount: u64,
        duration_seconds: i64,
        risk_tier: u8,
        agent_address: Pubkey,
    ) -> Result<()> {
        create_policy_handler(ctx, coverage_amount, duration_seconds, risk_tier, agent_address)
    }

    /// Cancel a policy with partial refund.
    pub fn cancel_policy(ctx: Context<CancelPolicy>) -> Result<()> {
        cancel_policy_handler(ctx)
    }

    /// Submit an insurance claim.
    pub fn submit_claim(
        ctx: Context<SubmitClaim>,
        trigger_type: u8,
        trigger_tx_signature: Vec<u8>,
    ) -> Result<()> {
        submit_claim_handler(ctx, trigger_type, trigger_tx_signature)
    }

    /// Verify a claim and execute payout (oracle only).
    pub fn verify_and_payout(ctx: Context<VerifyAndPayout>, payout_amount: u64) -> Result<()> {
        verify_and_payout_handler(ctx, payout_amount)
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
}
