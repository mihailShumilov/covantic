# Backend API — AgentGuard

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
    schema.ts           — 5 tables: agents, policies, claims, monitoringEvents, vaultSnapshots
    migrate.ts          — Drizzle migrator
    seed.ts             — Demo data (2 agents, vault snapshot, events)
  services/
    risk-scorer.ts      — 7-factor weighted risk model, Helius API integration
    claim-oracle.ts     — 4 trigger verifiers (exploit, oracle manip, agent error, governance)
    transaction-monitor.ts — Helius webhook processing, anomaly detection
    notification-service.ts — WebSocket + Redis pub/sub
  routes/
    health.ts, risk.ts, policies.ts, claims.ts,
    vault.ts, staking.ts, monitoring.ts, protocol.ts
  workers/
    expiry-crank.ts     — Every 60s, expire overdue policies
    solvency-checker.ts — Every 5min, check vault health
    analytics-aggregator.ts — Every 1hr, snapshot stats
  middleware/
    error-handler.ts    — Zod + generic error handling
    rate-limit.ts       — Redis-based, 100 req/min/IP
```

## Key Patterns

- Fastify 5 with plugin architecture — each route file exports a plugin
- Drizzle ORM (not Prisma) — schema-first, no migrations directory needed with `db:push`
- BullMQ workers with Redis — repeatable jobs
- Fastify instance decorated with `db`, `redis`, `config` (typed in `types/index.ts`)
- All routes under `/api/` prefix
- WebSocket at `/ws` with channel subscriptions (claims:feed, vault:stats, monitoring:alerts)
- Pino logger (Fastify built-in)

## Commands

```bash
pnpm --filter api dev       # Dev with watch
pnpm --filter api build     # Compile TS
pnpm --filter api run db:push   # Push schema to DB
pnpm --filter api run db:seed   # Seed demo data
```

## Port: 4000
