# Covantic — AI Agent Insurance Protocol on Solana

## Project Overview

Parametric insurance protocol for AI agents on Solana. Colosseum Frontier Hackathon project.
Agents buy insurance before DeFi operations; claims are auto-verified and paid out on-chain via oracle.

## Monorepo Structure

```
packages/
  anchor/   — Solana program (Rust, Anchor 0.30.1)
  api/      — Backend (Fastify 5, Drizzle ORM, BullMQ)
  web/      — Frontend (Next.js 16, React 19, Tailwind)
  sdk/      — Solana Agent Kit plugin (TypeScript)
  shared/   — Cross-package types, constants, utilities
```

## Tech Stack

- **Runtime**: Node.js 22+, pnpm 9+ workspaces, Turborepo
- **Language**: TypeScript (ES2025, strict, verbatimModuleSyntax), Rust (Anchor)
- **DB**: PostgreSQL 18, Redis 7 (Docker Compose in `docker/`)
- **Blockchain**: Solana devnet, USDC SPL token, Helius API

## Commands

```bash
pnpm dev              # Start all (docker + api:4099 + web:3099)
pnpm build            # Build all packages
pnpm test             # Run all tests
pnpm test:anchor      # Anchor tests only
pnpm docker:up/down   # Manage Docker services
pnpm db:seed          # Seed database
pnpm setup            # Full local setup (scripts/setup-local.sh)
pnpm deploy:devnet    # Deploy anchor program
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
- Risk tiers: LOW(0), MEDIUM(1), HIGH(2), EXTREME(3) → 100/250/500 bps annual
- Solvency thresholds: Emergency<50%, Critical 50-100%, Caution 100-200%, Healthy≥200%
- Trigger types: Exploit(1), OracleManipulation(2), AgentError(3), GovernanceAttack(4)
- Unstake cooldown: 48 hours

## Git

- Remote: `git@github.com:mihailShumilov/ai-agent-insurance.git`
- No AI attribution in commits or docs
