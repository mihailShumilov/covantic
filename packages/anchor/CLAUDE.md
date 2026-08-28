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
    checkpoint_balance.rs — Permissionless crank: records the covered balance
    verify_and_payout_exploit.rs — Bounds payout by a drop the program measures
    verify_and_payout_v2.rs      — Bounds payout by a guardian-signed Pyth price
    declare_governance_baseline.rs — Holder-signed authority manifest, matures on a delay
    checkpoint_authority.rs        — Permissionless crank: records who controls the account
    verify_and_payout_governance.rs — Bounds payout by a departure the program observes
    declare_agent_mandate.rs        — Holder-signed operating envelope, matures on a delay
    verify_and_payout_agent_error.rs — Bounds payout by the overshoot past that envelope
```

## Governance Proof Path

`declare_governance_baseline` is **holder-signed** and matures after
`GOVERNANCE_BASELINE_DELAY` (1 h). `checkpoint_authority` is permissionless
and records the covered account's owner, delegate, close authority and frozen
flag. `verify_and_payout_governance` compares the matured declaration against
what it reads now and refuses to pay unless control left the declared set.

Two constraints that must not be "simplified":

- The covered account is derived with `address =
  get_associated_token_address(&policy.agent_address, &usdc_mint.key())`, not
  with `associated_token::authority`. Anchor compiles the latter into an owner
  equality check, which rejects precisely the seizure being observed.
- Checkpoint staleness is measured against `policy.claim_submitted_at`, not
  `now`. The governance lock is 2 h and the staleness allowance is 2 h, so
  measuring against `now` makes every payout unsatisfiable.

## Agent Mandate Proof Path

`declare_agent_mandate` is **holder-signed** and matures after
`MANDATE_DECLARATION_DELAY` (1 h). `verify_and_payout_agent_error` re-reads the
covered balance against `checkpoint_balance`'s reading and pays at most the
amount by which the drop exceeded the declared cap — or by which the account
fell below the declared retention floor.

Three constraints that must not be "simplified":

- **A first declaration leaves `prev_*` at zero.** `envelope_at` falls back to
  `prev_*` when the current declaration had not matured before the claim, so
  seeding a new declaration's predecessor with its own values and `now` makes
  it usable as proof immediately and disables the maturity delay entirely.
- **Checkpoint staleness is measured against `policy.claim_submitted_at`**, and
  here it is arithmetic rather than preference: the lock is 6 h and the
  allowance is 2 h, so the exploit path's comparison against `now` would make
  every payout on this trigger unsatisfiable.
- **Only measurable breaches settle.** The counterparty and program allowlists
  are recorded, not enforced — the program cannot inspect a past transaction.
  A breach of those alone produces no overshoot and `require!(breach_excess >
  0)` refuses it, on purpose: paying it would mean releasing funds on the
  oracle's unverifiable word.

Unlike the governance instructions, this one *does* use
`associated_token::authority`: an agent error is by definition something the
agent did while still owning its account, so the owner-equality check is a
constraint rather than an obstacle.

## Key Patterns

- Anchor 1.1.2 with `anchor-spl` for token CPI. `anchor-lang` and
  `pyth-solana-receiver-sdk` must move together — mismatched versions pull two
  `solana-program` majors into one binary and fail as a wall of
  "Pubkey: BorshSerialize is not satisfied", which names nothing useful.
- `CpiContext::new`/`new_with_signer` take the program **id** (`.key()`), not
  its `AccountInfo` — an Anchor 1.x change.
- TS client is `@coral-xyz/anchor` 0.32.1 (no 1.x is published). `.accounts()`
  is strict there; use `.accountsPartial()` when passing accounts the resolver
  could derive.
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
