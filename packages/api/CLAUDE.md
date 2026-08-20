# Backend API — Covantic

## Structure

```
src/
  index.ts              — Bootstrap: config → migrations → Fastify → routes → workers
  config/
    env.ts              — Zod-validated env vars, loadConfig()
    database.ts         — Drizzle + pg Pool
    redis.ts            — ioredis connection
    solana.ts           — @solana/web3.js Connection, loadKeypair()
  db/
    schema.ts           — 6 tables: agents, riskAssessments, policies, claims, monitoringEvents, vaultSnapshots
    custom-constraints.ts — Drizzle migrator extensions (partial unique indexes, etc.)
    migrate.ts          — Drizzle migrator
    seed.ts             — Demo data
  services/
    risk-scorer.ts        — 7-factor weighted risk model, Helius API integration
    claim-oracle.ts       — Dispatcher over per-trigger verifiers
    verifiers/            — exploit, oracle-manipulation, agent-error, governance-attack
    oracle/               — Oracle-manipulation evidence spine (see below)
    governance/           — Governance-attack evidence spine (see below)
    event-vocabulary.ts   — MonitoringEventType → TriggerType, the one contract
    transaction-monitor.ts — Helius webhook processing, anomaly detection
    alert-bus.ts          — HMAC-signed publish/subscribe over Redis `monitoring:alerts`
    attestation-publisher.ts — Oracle-signed RiskAttestation PDA publisher (lazy-init CPI)
    helius-webhook.ts     — Helius webhook REST client (used by sync-helius-webhook.ts)
    notification-service.ts — WebSocket + Redis pub/sub
    fleet/                — manifest / actions / failures / types for the autonomous agent fleet
  routes/
    health.ts       — /api/health
    risk.ts         — /api/risk/:addr, /api/assessments[/:id]
    policies.ts     — /api/policies[/:id], /policies/quote, /policies/enrichment, /policies/:id/why-active
    claims.ts       — /api/claims[/:id]
    vault.ts        — /api/vault/stats, /api/vault/history, /api/protocol/overview
    staking.ts      — /api/staking/:address
    monitoring.ts   — /api/monitoring/{events,webhook,metrics}, /api/demo/simulate-exploit
    fleet.ts        — /api/fleet
  workers/
    oracle-watcher.ts     — Every 2min: re-screens insured agents' recent txs (webhooks drop)
    expiry-crank.ts       — Every 60s + on-boot: on-chain expire_policy for stale policies (oracle signer)
    solvency-checker.ts   — Every 5min: on-chain vault read → solvency status
    analytics-aggregator.ts — Hourly: vault snapshot
    policy-indexer.ts     — Every 60s + on-boot: mirrors on-chain InsurancePolicy accounts into Postgres
    claim-keeper.ts       — Subscribes to monitoring:alerts, drives oracle_submit_claim + verify_and_payout
    monitor-entry.ts      — Standalone entrypoint for the monitor container (prod)
  utils/
    helius.ts             — Helius enhanced-tx client (cluster-aware — pass SOLANA_NETWORK)
    pyth.ts               — Pyth benchmarks client
    program.ts            — createCovanticProgram (oracle or read-only)
    policy-reader.ts      — fetchOnChainPolicy (structured {policy, reason, detail})
    monitor-metrics.ts    — Redis counters for /api/monitoring/metrics
    logger.ts             — Pino logger
  middleware/
    error-handler.ts      — Zod + generic error handling
    rate-limit.ts         — Redis-based, 100 req/min/IP
  scripts/
    init-protocol.ts      — Idempotent protocol init (called from scripts/init-devnet.sh)
    mint-mock-usdc.ts     — Mint devnet test-USDC (authority = oracle keypair)
    sync-helius-webhook.ts — Register/update Helius webhook for every insured agent
    agent-wallet.ts       — create / fund / trigger CLI for throwaway agent keypairs
    fleet-{bootstrap,start,status}.ts — Autonomous fleet management
    stake-vault.ts        — Stake USDC into the vault (raise solvency ratio)
    claim-replay.ts       — Re-derive stored verdicts from evidence; CI-gateable
    declare-governance-baseline.ts — Holder-signed authority manifest (pnpm gov:declare)
    seed-demo.ts, simulate-exploit.ts, run-demo.ts, demo-common.ts — demo helpers
```

## Oracle Module (`services/oracle/`)

The evidence spine behind `TriggerType.OracleManipulation`.

```
types.ts            PricePoint / PriceWindow / PriceSource / EvidenceBundle
price-sources/
  pyth-hermes.ts    Historical, guardian-signed prices at a timestamp
  cex.ts            Binance / Coinbase / Kraken minute candles
consensus.ts        ConsensusPricer — median + dispersion across sources
execution.ts        Net position change from accountData balance deltas
valuation.ts        Values both sides in USD at the block time
signatures.ts       Structural manipulation markers
adjudicate.ts       PURE verdict function — no I/O, no clock
prefilter.ts        Cheap webhook screen that raises `oracle_deviation`
proof-poster.ts     Posts the signed update and calls verify_and_payout_v2
hash.ts             Canonical JSON + bundle/verdict hashes
factory.ts          buildPriceOracle() — the one production source set
```

### Invariants

- **Every price is read at the trigger transaction's block time.** Never spot.
  Comparing a historical swap to a live price measures market drift, not the
  fill, and it was the single most severe bug in the original verifier.
- **A verdict never rests on one source.** A lone feed cannot establish that a
  feed was manipulated — it may be the manipulated one. Priced legs need three
  agreeing sources; below that the claim goes to review.
- **`indeterminate` is not `rejected`.** Outages, unindexed transactions,
  missing feeds and disagreeing references all retry and then escalate. A
  claim is only closed by evidence that contradicts it.
- **Detection fails open, settlement fails closed.** `prefilter.ts` raises a
  candidate when it cannot price a swap; `proof-poster.ts` failing sends the
  claim to review rather than back to the unverified instruction.
- **`adjudicate()` performs no I/O and reads no clock.** That is what makes
  `pnpm claim:replay` meaningful. Tests enforce it.
- **Anomaly ordering matters.** A policy holds one open claim, so
  `oracle_deviation` is published ahead of `large_transfer` for the same tx.

## Governance Module (`services/governance/`)

The evidence spine behind `TriggerType.GovernanceAttack`.

```
authority.ts        Who controls the agent's accounts, before and after
conjunction.ts      What the takeover cost, and whether it landed in the window
signatures.ts       Structural markers separating a takeover from an operation
adjudicate.ts       PURE verdict function — no I/O, no clock
types.ts            GovernanceBaselineView / GovernanceEvidenceBundle
prefilter.ts        Screen a RawTxView for a departure from the legitimate set
checkpoint.ts       Writes checkpoint_authority; reads the declared baseline
proof-poster.ts     Calls verify_and_payout_governance
```

### Invariants

- **The covered event is on-chain state, not an inference.** Who controls a
  token account is a field on that account. The holder declares who *may*
  control it (`declare_governance_baseline`, holder-signed, matures after an
  hour), and the program compares that against what it reads. This is the only
  trigger where the chain establishes the event itself rather than bounding
  its size.
- **No declaration ⇒ review, never rejection.** A policy predating the
  mechanism has no declared set; that is a gap in our records, not consent.
  An *outage* reading the baseline is a third state again, and retries.
- **The governance instructions derive the covered account by `address`, not
  by `associated_token::authority`.** The latter compiles into an owner
  equality check and would reject exactly the state being observed. This is
  also why the exploit path cannot settle a seizure.
- **`gone` and `frozen` cannot double-count.** `gone` is what is missing from
  current holdings; `frozen` is a subset of what is present. On chain the
  equivalent bound is `max(observed_drop, seized_amount)`, never the sum — and
  `seized_amount` is zero for delegate and close-authority departures, which
  are capabilities rather than losses.
- **Program membership decides nothing.** "A governance program was invoked"
  was the entirety of the old verifier and establishes nothing: a takeover of
  an agent wallet is a `SetAuthority` against its own accounts and touches no
  DAO program. `programs` is carried in the bundle as an audit trail only.
- **Detection is pull-path only**, by design — nothing this screen needs
  exists in the Helius payload. See the note at the top of `prefilter.ts`.

## Fleet Module (`services/fleet/`)

```
manifest.ts   — Load/save keys/fleet.json
types.ts      — FleetAgent, FleetManifest, FleetActivityEntry, BehaviorProfile
actions.ts    — rollAction / rollRogue / executeTransfer / executeFail / runOneAction
failures.ts   — FailureStrategy abstraction + buildFailingInstruction (PURE)
```

### Failure Strategies

`failures.ts` exposes a registry of `FailureStrategy` objects, one per verifier
branch. Each strategy declares its `kind`, its `expectedError` (structured
on-chain error class), and a pure `buildInstruction(agent)` fn. Current
strategies:

- `failed_tx` — SPL Memo v2 with a 32-byte non-UTF-8 payload (`0xFF`).
  Returns `InstructionError::InvalidInstructionData` at runtime.

`executeFail` uses `sendRawTransaction({ skipPreflight: true })` + explicit
`confirmTransaction` so the tx **lands on-chain** with a real signature and a
non-null `meta.err` — the only way the AgentError verifier's `failed_tx`
branch can fire. A client-side serialize throw would have produced no sig.
`ActionResult.onChainErr` carries the structured error; `ActionResult.error`
is reserved for runner-side exceptions (RPC down, signing bug) and should be
alerted on in production.

New strategies (`critical_transfer`, `rapid_loss`, `governance_attack`) should
be added to `failures.ts` and then exposed via `BehaviorProfile.rogueMix`.

## Key Patterns

- Fastify 5 with plugin architecture — each route file exports a plugin
- Drizzle ORM (not Prisma) — schema-first, no migrations directory needed with `db:push`
- BullMQ workers with Redis — repeatable jobs
- Fastify instance decorated with `db`, `redis`, `config`, `attestationPublisher` (typed in `types/index.ts`)
- All routes under `/api/` prefix
- WebSocket at `/ws` with channel subscriptions (`claims:feed`, `vault:stats`, `monitoring:alerts`)
- Pino logger (Fastify built-in)
- `createCovanticProgram({ withOracle: true|false })` is the single entry point for any code
  that needs to read or write the Anchor program — avoid creating ad-hoc providers

## Webhook Auth

`POST /api/monitoring/webhook` accepts either:

- HMAC-SHA256 of the raw body on `x-helius-hmac-signature` (internal callers, tests)
- Static bearer token `Authorization: Bearer <HELIUS_WEBHOOK_SECRET>` (real Helius)

Anything else is 401. Rotate via `pnpm webhook:sync`.

## Alert Bus

The `monitoring:alerts` Redis channel is signed with `ALERT_HMAC_SECRET` (see
`services/alert-bus.ts`). The claim-keeper refuses unsigned or mismatched envelopes. Never
publish directly to the channel — always go through `publishAlert()`.

## Commands

```bash
pnpm --filter api dev             # Dev with watch
pnpm --filter api build           # Compile TS
pnpm --filter api run db:push     # Push schema to DB
pnpm --filter api run db:seed     # Seed demo data
```

## Port: 4099
