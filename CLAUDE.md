# Covantic — AI Agent Insurance Protocol on Solana

## Project Overview

Parametric insurance protocol for AI agents on Solana. Colosseum Frontier Hackathon project.
Agents buy insurance before DeFi operations; claims are auto-verified and paid out on-chain via oracle.

## Monorepo Structure

```
packages/
  anchor/   — Solana program (Rust, Anchor 1.1.2)
  api/      — Backend (Fastify 5, Drizzle ORM, BullMQ)
  web/      — Frontend (Next.js 16, React 19, Tailwind)
  shared/   — Cross-package types, constants, utilities
```

## Related Repos

- TypeScript SDK (`@covantic/solana-sdk`) lives in a separate repo:
  `git@github.com:mihailShumilov/covantic-solana-sdk.git`
  — Do not add it back as a workspace package; develop there.

## Tech Stack

- **Runtime**: Node.js 22+, pnpm 9+ workspaces, Turborepo
- **Language**: TypeScript (ES2025, strict, verbatimModuleSyntax), Rust (Anchor)
- **DB**: PostgreSQL 18, Redis 7 (Docker Compose in `docker/`)
- **Blockchain**: Solana devnet, USDC SPL token, Helius API

## Commands

```bash
pnpm dev                 # Start all (docker + api:4099 + web:3099 + workers)
pnpm build               # Build all packages
pnpm test                # Run all tests
pnpm test:anchor         # Anchor tests only
pnpm docker:up/down      # Manage Docker services
pnpm db:seed             # Seed database
pnpm setup               # Full local setup (scripts/setup-local.sh)
pnpm init:devnet         # Build + deploy + initialize the Anchor program on devnet
pnpm deploy:devnet       # Deploy anchor program only (no init)
pnpm fund:phantom <wallet> [amount]   # Mint devnet test-USDC
pnpm webhook:sync        # Register/refresh the Helius webhook for all insured agents
pnpm agent:create|fund|trigger        # Throwaway agent keypair CLI (real on-chain activity)
pnpm fleet:bootstrap|start|status     # Autonomous fleet of policy-covered agents
pnpm stake:vault [--amount N]         # Stake USDC into the vault (lift solvency ratio)
pnpm --filter api claim:replay <id>   # Re-derive a stored claim verdict from its evidence
pnpm gov:declare --policy <id>        # Holder declares the agent's legitimate authority set
```

Filter to single package: `pnpm --filter api dev`, `pnpm --filter web dev`

## Code Style

- Single quotes, semicolons, trailing commas, 2-space indent, 100 char width
- ESLint + Prettier (config in root)
- Prefix unused params with `_`
- `no-console` except warn/error — use pino logger in api
- All comments and docs in English only

## Key Patterns

- **Imports**: Use `import type { X }` for type-only imports (verbatimModuleSyntax)
- **Shared types**: Import from `@covantic/shared` — never duplicate types
- **Env config**: Zod-validated in `packages/api/src/config/env.ts`
- **DB**: Drizzle ORM, schema in `packages/api/src/db/schema.ts`
- **Routes**: Fastify route plugins in `packages/api/src/routes/`
- **Workers**: BullMQ background jobs in `packages/api/src/workers/`
- **PDAs**: All on-chain state uses deterministic Program Derived Addresses
- **Premium split**: 70% stakers, 20% reserve, 10% protocol treasury

## Domain Constants (from shared/constants.ts)

- Coverage: 1–1,000,000 USDC (6 decimals)
- Duration: 1 hour–30 days
- Policy states: Active(0), ClaimPending(1), ClaimPaid(2), Expired(3), Cancelled(4)
- Risk tiers: LOW(0), MEDIUM(1), HIGH(2), EXTREME(3) → 100/250/500 bps annual
- Solvency thresholds: Emergency<50%, Critical 50-100%, Caution 100-200%, Healthy≥200%
- Trigger types: Exploit(1), OracleManipulation(2), AgentError(3), GovernanceAttack(4)
- Claim statuses: pending, verifying, approved, paying, paid, rejected, failed,
  indeterminate, review — the last two are OPEN states (see `OPEN_CLAIM_STATUSES`)
- Lock periods: exploit=0s, oracle_manipulation=1h, agent_error=6h, governance_attack=2h
- Governance baseline delay: 1 h (`GOVERNANCE_BASELINE_DELAY`); drain window: 30 min
- Unstake cooldown: 48 hours
- Attestation max validity: 3600 s (`ATTESTATION_MAX_VALIDITY_SECONDS`)
- Quote max assessment age: 600 s (stale → `ASSESSMENT_STALE`)

## Key Architectural Invariants

- `create_policy` does NOT accept a client-supplied tier. The tier comes from the
  oracle-signed `RiskAttestation` PDA, which `/api/policies/quote` publishes or refreshes
  before returning the quote.
- The `expiry-crank` worker is **on-chain**: it sends `expire_policy` to the program; the
  `policy-indexer` reconciles the resulting state change on its next tick. Never write
  `state` to the DB directly — the indexer owns it.
- The `policy-indexer`'s `onConflictDoUpdate` overwrites every on-chain-authoritative field
  (`pdaAddress`, `holder`, `agent`, amounts, times, state) — this is what makes post-
  redeploy self-healing work.
- `/api/monitoring/webhook` accepts HMAC-of-body OR `Authorization: Bearer <secret>`; real
  Helius deliveries use the bearer path since Helius does not HMAC-sign payloads.
- The internal `monitoring:alerts` Redis channel is signed with `ALERT_HMAC_SECRET`. The
  claim-keeper rejects unsigned alerts.
- Helius Enhanced Transactions (`getParsedTransaction`, `getEnhancedTransactions`) are
  **cluster-partitioned**: devnet signatures must hit `api-devnet.helius-rpc.com`,
  mainnet must hit `api-mainnet.helius-rpc.com`. Wrong cluster returns `[]` (not an
  error) and silently breaks every verifier's `triggerTxSignature` lookup. Always pass
  `SOLANA_NETWORK` into `new HeliusClient(apiKey, cluster)`. The retired
  `api.helius.xyz/v0` host must not come back.
- Claim verification is three-valued: `confirmed | rejected | indeterminate`. An
  unavailable price source, an unindexed trigger tx, or references that disagree
  must produce `indeterminate` (retry, then review) — never `rejected`. Closing a
  claim is a statement that the evidence contradicts it.
- Oracle-manipulation verdicts are produced by a **pure** `adjudicate(bundle)` in
  `services/oracle/adjudicate.ts`. No I/O, no `Date.now()`, no randomness: the
  same evidence must yield the same verdict forever, which is what
  `pnpm claim:replay` and the on-chain evidence hash rely on. Bump
  `ADJUDICATOR_VERSION` when behaviour changes rather than editing quietly.
- Exploit verdicts are produced by a **pure** `adjudicateExploit(bundle)` in
  `services/exploit/adjudicate.ts`, on the same contract as the oracle one:
  no I/O, no clock, no randomness. Bump `EXPLOIT_ADJUDICATOR_VERSION` rather
  than editing quietly. `claim-replay` dispatches on the bundle's own
  `triggerType`, so a bundle is self-contained evidence.
- **Authorization, not program membership, decides an exploit.** The verifier
  asks who signed for the movement — signer flags, transfer authority,
  delegates, `SetAuthority`/`CloseAccount`, destination control — all read from
  `connection.getParsedTransaction`. The Helius payload cannot answer any of
  it, so an exploit claim without a chain record is `indeterminate`, never
  rejected. Do not reintroduce "unknown program ⇒ exploit" or "DEX present ⇒
  not an exploit"; both were false-positive/false-negative engines.
- **Confidence is enforced, not decorative** (`services/confidence-lanes.ts`).
  Both adjudicators cap at 0.92, below `AUTO_PAY_CONFIDENCE` (0.95), so
  off-chain analysis can never release funds alone — paying always needs the
  chain's own check. That gap is the guarantee; do not close it by raising a
  ceiling.
- The exploit proof path is **measure, not attest**: there is no signed-history
  oracle for balances, so `checkpoint_balance` (permissionless) records what
  the program reads from the agent's ATA — derived via `associated_token`
  constraints, never accepted from the caller — and `verify_and_payout_exploit`
  re-reads it and refuses to pay more than the drop. The chain proves the money
  left; `bundle_hash` commits to the claim about *why*, which it cannot see.
- `balance_drop_unexplained` is **intentionally unmapped** in `EVENT_TO_TRIGGER`.
  It means balances fell with no transaction the screen could attribute it to —
  there is nothing to verify, so it goes to a human, not to a claim.
- `anchor build --no-idl` is the cheap check `cargo check` cannot replace: it
  catches BPF stack-frame overflows in `try_accounts`. Box account structs when
  it complains.
- **A seizure is not an exploit, and the exploit path cannot settle one.**
  `associated_token::authority = policy.agent_address` compiles into an owner
  equality check, so once `SetAuthority(AccountOwner)` lands, both
  `checkpoint_balance` and `verify_and_payout_exploit` fail to load the covered
  account — and the balance never dropped anyway. The governance instructions
  derive it by `address = get_associated_token_address(...)` instead, which
  still denies the caller a choice of account while allowing the owner to have
  changed. Never "simplify" those back to `associated_token::authority`.
- **Governance ranks above exploit in `ANOMALY_SPECIFICITY` (5 vs 4).** A
  policy holds one open claim, so whichever anomaly is raised first decides the
  trigger. A takeover that also drains is a takeover; filing it as an exploit
  routes it to a verifier with nothing to say about who owns the account now,
  and the freeze shape — where nothing moves at all — would be rejected as
  `no_net_loss`.
- **A governance verdict rests on a holder-signed declaration, not an
  inference.** `declare_governance_baseline` is holder-signed and matures on a
  delay (`GOVERNANCE_BASELINE_DELAY`, 1h); `verify_and_payout_governance`
  refuses a baseline that had not matured *before the claim was filed*. No
  declaration means `indeterminate → review`, never a rejection — the absence
  of a declaration is a gap in our records, not the holder's consent.
- **Checkpoint staleness is measured against `claim_submitted_at` on the
  governance path**, not against `now`. The governance lock is two hours, which
  is the entire staleness allowance, so measuring against `now` would make
  every governance payout unsatisfiable. The exploit path still measures
  against `now`; that works only because its lock is an hour, and it is
  fragile.
- `MonitoringEventType` and `EVENT_TO_TRIGGER` (`services/event-vocabulary.ts`)
  are one contract, enforced by `Record<MonitoringEventType, …>` plus
  `tests/monitoring-vocabulary.test.ts`. Producers must use enum members, not
  string literals — literals are how the two drifted apart and made every
  governance alert silently unroutable.
- Fleet `fail` actions **must land on-chain** with a real signature + non-null `meta.err`.
  `executeFail` uses `sendRawTransaction({ skipPreflight: true })` + explicit
  `confirmTransaction`; strategies live in `packages/api/src/services/fleet/failures.ts`.
  A client-side serialize throw is a bug — the AgentError `failed_tx` verifier branch
  can't see those.

## Git

- Remote: `git@github.com:mihailShumilov/covantic.git`
- No AI attribution in commits or docs
