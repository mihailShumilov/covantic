# Anchor Program — Covantic

## Structure

```
src/
  lib.rs              — Program entry, declare_id!, 10 instruction handlers
  constants.rs        — All on-chain constants (seeds, limits, BPS values)
  errors.rs           — CovanticError enum (20+ variants)
  events.rs           — 8 event structs (PolicyCreated, ClaimPaid, Staked, etc.)
  state/
    protocol_config.rs  — ProtocolConfig PDA (admin, oracle, usdc_mint, paused)
    insurance_policy.rs — InsurancePolicy PDA (holder, agent, coverage, state 0-5)
    insurance_vault.rs  — InsuranceVault PDA (staked, coverage, solvency)
    staker_position.rs  — StakerPosition PDA (amount, rewards, cooldown)
  instructions/
    initialize.rs       — Create config + vault + vault ATA
    create_policy.rs    — Premium calc, USDC transfer, 70/20/10 split
    cancel_policy.rs    — 80% pro-rata refund via vault PDA signer
    submit_claim.rs     — Set ClaimPending, validate trigger type
    verify_and_payout.rs — Oracle-only, lock period check, CPI payout
    expire_policy.rs    — Permissionless crank, time check
    stake.rs            — USDC deposit, update vault solvency
    unstake.rs          — Two-phase: request (timestamp) + execute (48h cooldown)
    claim_rewards.rs    — Proportional staker rewards, CPI transfer
```

## Key Patterns

- Anchor 0.30.1 with `anchor-spl` for token CPI
- All state accounts are PDAs with seeds in `constants.rs`
- Vault signs CPI transfers using PDA seeds + bump
- Policy states: Active(0), ClaimPending(1), ClaimApproved(2), ClaimPaid(3), Expired(4), Cancelled(5)
- `checked_mul`, `checked_div`, `checked_add` for all math — return MathOverflow error

## Commands

```bash
anchor build          # Build program
anchor test           # Run tests (starts local validator)
anchor deploy         # Deploy to configured cluster
```

## Error Handling

All errors use `CovanticError` enum with `#[msg("...")]` attributes.
Key: CoverageTooLow, PolicyNotActive, UnauthorizedOracle, InsufficientVaultBalance, UnstakeCooldownNotMet.
