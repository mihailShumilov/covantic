# Anchor Program — Covantic

## Structure

```
src/
  lib.rs              — Program entry, declare_id!, 12 instruction handlers
  constants.rs        — All on-chain constants (seeds, limits, BPS values)
  errors.rs           — CovanticError enum
  events.rs           — Event structs (PolicyCreated, ClaimPaid, PolicyExpired, etc.)
  state/
    protocol_config.rs  — ProtocolConfig PDA (admin, oracle, usdc_mint, paused)
    insurance_policy.rs — InsurancePolicy PDA (version, holder, agent, coverage, state 0-4)
    insurance_vault.rs  — InsuranceVault PDA (staked, coverage, solvency, reward accumulator)
    staker_position.rs  — StakerPosition PDA (amount, rewards, reward debt, cooldown)
    risk_attestation.rs — RiskAttestation PDA (oracle-signed tier + expires_at)
  instructions/
    initialize.rs         — Create config + vault + vault ATA
    update_config.rs      — Admin-only: pause flag, oracle rotation
    upsert_attestation.rs — Oracle-only: publish / refresh RiskAttestation for an agent
    create_policy.rs      — Reads tier from attestation PDA, transfers USDC, 70/20/10 split
    cancel_policy.rs      — 80% pro-rata refund via vault PDA signer
    submit_claim.rs       — Holder-filed claim path (sets ClaimPending)
    oracle_submit_claim.rs — Oracle-driven claim path (auto-claim pipeline entry)
    verify_and_payout.rs  — Oracle-only, lock period check, CPI payout to holder ATA
    expire_policy.rs      — Permissionless crank, time check (called by workers/expiry-crank.ts)
    stake.rs              — USDC deposit, crystallize pending rewards first
    unstake.rs            — Two-phase: request (timestamp) + execute (48h cooldown)
    claim_rewards.rs      — Pull rewards via the per-stake accumulator
```

## Key Patterns

- Anchor 0.30.1 with `anchor-spl` for token CPI
- All state accounts are PDAs with seeds in `constants.rs`
- Vault signs CPI transfers using PDA seeds + bump
- Policy states: Active(0), ClaimPending(1), ClaimPaid(2), Expired(3), Cancelled(4)
- `#[account(InitSpace)]` on versioned state structs (first field is `version: u8` for
  forward-compatible deserialization)
- `checked_mul`, `checked_div`, `checked_add` for all math — return MathOverflow error
- Staking uses a per-stake reward accumulator so rewards cannot be double-claimed (audit fix)

## Oracle-Sourced Risk Attestation

`create_policy` does NOT accept a `risk_tier` argument. Before the tx is built, the API
calls `upsert_attestation` (signed by the oracle), which writes a `RiskAttestation` PDA
seeded by the agent address containing `tier` and `expires_at`. `create_policy` then reads
the tier from that PDA and enforces `attestation.agent == agent_address && now <= expires_at`.
This closes the adverse-selection hole where a buyer could pick LOW for a HIGH agent.

## Commands

```bash
anchor build          # Build program
anchor test           # Run tests (starts local validator)
anchor deploy         # Deploy to configured cluster
```

From the monorepo root:

```bash
pnpm init:devnet      # idempotent build + deploy + initialize
pnpm test:anchor      # anchor test (forwarded from turbo)
```

## Error Handling

All errors use `CovanticError` enum with `#[msg("...")]` attributes. Key variants:
`CoverageTooLow`, `PolicyNotActive`, `PolicyNotExpired`, `UnauthorizedOracle`,
`InsufficientVaultBalance`, `UnstakeCooldownNotMet`, `AttestationExpired`,
`AttestationAgentMismatch`.
