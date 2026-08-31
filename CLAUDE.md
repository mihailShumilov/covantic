# Covantic — AI Agent Insurance Protocol on Solana

## Project Overview

Parametric insurance protocol for AI agents on Solana. Colosseum Frontier Hackathon project.
Agents buy insurance before DeFi operations; claims are auto-verified and paid out on-chain via oracle.

## Monorepo Structure

```
packages/
  anchor/   — Solana program (Rust, Anchor 1.0.2 — see packages/anchor/Anchor.toml)
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
pnpm mandate:declare --policy <id> --max-single <usdc>  # Holder declares the agent's operating envelope
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
- Agent mandate delay: 1 h (`MANDATE_DECLARATION_DELAY`); min provable breach: 1 USDC
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
- **Every chain READ goes through `SolanaReader`; every chain WRITE stays on the
  v1 `Connection`.** Reads fan out across `SOLANA_RPC_URL` plus
  `SOLANA_RPC_FALLBACK_URLS` with per-endpoint circuit breakers
  (`packages/api/src/config/rpc-pool.ts`, built on `solana-resilience-kit`);
  sends do not, because a transaction that lands twice is worse than one that
  lands late. The reader hands back plain numbers, strings and Buffers — no
  `bigint` and no web3.js types cross that boundary, or the canonical JSON
  behind every evidence hash would change and `pnpm claim:replay` would stop
  agreeing with stored verdicts. Do not thread a `Connection` into a verifier
  again: one endpoint was a single point of failure for *settlement*, since a
  quota outage stops the balance checkpoints the exploit and agent-error proof
  paths are bounded by. `GET /api/health/rpc` reports per-endpoint state.
  Anchor account reads go through `utils/anchor-reader.ts` for the same reason
  — `program.account.X.all()` is a `getProgramAccounts` on one endpoint's
  quota, every 60 s — with **exactly three exceptions**, each carrying a
  comment saying so and enforced by `tests/read-pool-discipline.test.ts`: a
  read that asks whether *our own* write landed (`isPolicySettledOnChain`, the
  `ClaimPending` rescue in the keeper, `AttestationPublisher.fetchExisting`)
  stays on the connection we wrote from, because an endpoint a few slots behind
  would answer "no" about a transaction that succeeded. That list was once
  written as three and was actually nine; the test exists so it cannot drift
  again.
- **Every endpoint's cluster is verified at boot** (`verifyReaderCluster`). A
  wrong-chain endpoint answers `getAccountInfo` with an authoritative "does not
  exist", which this codebase is contractually required to read as *absence* —
  turning a holder's matured declaration into a record it was never made. A
  mismatched fallback is ejected; a mismatched primary refuses the process.
- **A JSON-RPC error body is a failure, not a success.** `-32005 node is
  behind` and friends arrive as HTTP 200, kit's transport only throws on
  `!response.ok`, and the pool only fails over on a throw — so
  `withCircuitBreaker` converts them. Without that the one failure class most
  likely to be answerable by another endpoint never fails over, and the health
  surface reports `ok` throughout.
- **A read that can close a claim is corroborated by a second endpoint.**
  `fetchAnchorAccount(..., { corroborate: true })` reads a holder's governance
  baseline and agent mandate from two endpoints and requires them to agree;
  a disagreement throws, so the claim resolves to review. The asymmetry is the
  reason: the four proof instructions re-derive a payout from state the program
  reads itself, so no endpoint can cause an *overpayment* — but rejection is
  computed entirely off chain, is terminal, and its whole basis was one
  endpoint's answer. For an insurance protocol, wrongful denial is the loss the
  product exists to prevent.
- **A drain through a delegate the agent itself approved is not an exploit.**
  Only an account's owner can sign `Approve`, so the consent is real and sits
  one transaction earlier. `services/exploit/delegate-provenance.ts` resolves
  it and `adjudicateExploit` routes `granted_by_agent` to
  `agent_delegated_movement` (rejected) and an unreadable history to
  `indeterminate` — never to a payout. Without this a holder could buy 100,000
  USDC of cover for 0.57 USDC, drain to their own second wallet, and be paid.
- **Authorization, not program membership, decides an exploit.** The verifier
  asks who signed for the movement — signer flags, transfer authority,
  delegates, `SetAuthority`/`CloseAccount`, destination control — all read from
  `reader.getParsedTransaction`. The Helius payload cannot answer any of
  it, so an exploit claim without a chain record is `indeterminate`, never
  rejected. Do not reintroduce "unknown program ⇒ exploit" or "DEX present ⇒
  not an exploit"; both were false-positive/false-negative engines.
- **Confidence is enforced, not decorative** (`services/confidence-lanes.ts`).
  All four adjudicators cap at 0.92 — one `CONFIDENCE_CEILING`, defined beside
  `AUTO_PAY_CONFIDENCE` and re-exported, so the two numbers cannot drift
  apart — below `AUTO_PAY_CONFIDENCE` (0.95), so
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
  it complains. Pass `--ignore-keys`: the deploy keypair in `target/deploy`
  differs from the `declare_id!`, and without the flag the build refuses with
  a message recommending `anchor keys sync` — which must never be run, because
  it rewrites `PROGRAM_ID` in the source and orphans every deployed PDA.
- **Demo builds shorten locks, never maturity delays.** `devnet-fast-lock`
  drops all four `LOCK_*` constants to 30 s so a full run fits in a minute. It
  deliberately does not touch `MANDATE_DECLARATION_DELAY` or
  `GOVERNANCE_BASELINE_DELAY`: a lock is a window for intervention and costs
  only time to shorten, while a maturity delay is the evidence itself — it is
  what makes a declaration a statement that predates the loss. A Rust unit
  test asserts the feature leaves both at an hour.
- **A lock that has not elapsed is a wait, not a verdict.** The off-chain wait
  (`EXPLOIT_LOCK_SECONDS`, `AGENT_ERROR_LOCK_SECONDS`) and the on-chain
  constant are two numbers nothing keeps in agreement, so the keeper defers on
  `LockPeriodNotElapsed` along a schedule that outlasts the longest lock, and
  escalates to review only past it. Recording `failed` there closed a claim the
  chain was merely asking us to wait for. The error is matched by *name*:
  Anchor numbers errors by enum position, so a hard-coded 6014 silently
  migrates onto a different failure when a variant is inserted.
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
- **An agent error is a breach of a declared mandate, not an inference.** The
  trigger covers a loss the agent caused with its *own* authority — the case
  `adjudicateExploit` rejects as `agent_authorized_movement` — so no forensic
  evidence separates a mistake from a decision. `declare_agent_mandate` is
  holder-signed and matures on a delay (`MANDATE_DECLARATION_DELAY`, 1 h);
  `verify_and_payout_agent_error` refuses a mandate that had not matured
  *before the claim was filed*. No declaration means `indeterminate → review`,
  never a rejection.
- **The payout is the overshoot, not the loss.** The vault owes the amount by
  which the movement exceeded the declared cap (or fell below the declared
  retention floor), so the mandate is a deductible the holder authors. It is
  also what gives the chain an arithmetic bound: a compromised oracle key
  pointed at an agent that merely spent money extracts nothing.
- **A first mandate declaration must leave `prev_*` at zero.** `envelope_at`
  falls back to `prev_*` when the current declaration had not matured, so
  seeding a new declaration's predecessor with its own values and `now` — the
  natural thing to write — makes it usable as proof the instant it is written
  and silently disables the entire maturity delay.
- **`verify_and_payout_agent_error` settles only breaches it can measure.** It
  re-derives the outflow cap and the retention floor from a balance it reads;
  it cannot inspect a past transaction, so counterparty and program allowlist
  breaches produce no overshoot. Those confirm off chain and go to a reviewer —
  `planProvenSettlement` fails them closed as `breach_not_chain_checkable`
  rather than sending a transaction that would revert, because a failed payout
  is recorded `failed`, not `review`.
- **Checkpoint staleness on the agent-error path is measured against
  `claim_submitted_at`, and here that is arithmetic rather than preference.**
  `LOCK_AGENT_ERROR` is 6 h and `MAX_MANDATE_CHECKPOINT_AGE` is 2 h, so the
  exploit path's comparison against `now` would make *every* payout on this
  trigger unsatisfiable — not merely fragile, as it is on the governance path.
- **`bundleHash` is folded into `verificationData` by `recordEvidence`, not by
  each verifier.** `planProvenSettlement` refuses to route to a proven
  instruction without it, and only the price verifier used to set it — so both
  other proof paths would have planned `unprovable: no_bundle_hash` on every
  claim once their flags were switched on. One writer, all four triggers.
- **Only the mandate-relative signal opens an agent-error claim.**
  `large_transfer` and `failed_tx` are both intentionally unmapped in
  `EVENT_TO_TRIGGER`. A signal that cannot reference a declaration cannot
  describe the covered event, and leaving either mapped fills the policy's
  single open-claim slot with a claim that resolves to `review` — an OPEN
  status — which then blocks every genuine exploit or governance alert for
  that policy.
- `MonitoringEventType` and `EVENT_TO_TRIGGER` (`services/event-vocabulary.ts`)
  are one contract, enforced by `Record<MonitoringEventType, …>` plus
  `tests/monitoring-vocabulary.test.ts`. Producers must use enum members, not
  string literals — literals are how the two drifted apart and made every
  governance alert silently unroutable.
- **Detection never depends on one vendor.** The exploit sweep discovers
  transactions with `reader.getSignaturesForAddress` over the endpoint pool,
  not through Helius — it only ever read `signature` and `timestamp` from the
  enhanced payload, and everything it screens on comes from `fetchRawTxView`.
  Routing discovery through Helius made the entire pull path fail closed on one
  quota, and it did: the key returned `max usage reached`, six hours passed
  with zero webhook deliveries, and every health check stayed green, because a
  sweep that cannot list transactions reports nothing to examine. All three
  raw screens — `screenRawTxForGovernance`, `screenRawTxForExploit`,
  `screenRawTxForMandateBreach` — run there, in that order, which is
  `ANOMALY_SPECIFICITY` descending. Do not reintroduce an enhanced-transaction
  call on a detection path.
- **Only `mandate_envelope_exceeded` opens an agent-error claim.**
  `large_valued_outflow` and `unpriceable_outflow` name a size, not a covered
  event; both route to `large_transfer`, which opens nothing. Routing either to
  `AgentError` fills the policy's single open-claim slot with a claim that
  resolves to review and blocks every genuine alert for that policy.
- Fleet `fail` actions **must land on-chain** with a real signature + non-null `meta.err`.
  `executeFail` uses `sendRawTransaction({ skipPreflight: true })` + explicit
  `confirmTransaction`; strategies live in `packages/api/src/services/fleet/failures.ts`.
  A client-side serialize throw is a bug. Note that `failed_tx` no longer opens
  a claim: fee burn is an operational signal, and the fleet's deliberate
  failures were what made this trigger a denial-of-coverage vector.

## Git

- Remote: `git@github.com:mihailShumilov/covantic.git`
- No AI attribution in commits or docs
