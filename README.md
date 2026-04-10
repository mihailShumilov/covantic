# Covantic

**The coverage primitive for autonomous agents.**

Covantic is the first parametric insurance protocol for AI agents on Solana. Agents purchase coverage before DeFi operations. When a covered event occurs — exploit, oracle manipulation, critical error — the protocol verifies the claim on-chain and pays out instantly. No human review. No paperwork.

> Built for [Colosseum Frontier Hackathon](https://colosseum.org) — April–May 2026

## How It Works

1. **Assess** — AI Risk Scorer analyzes 15 on-chain signals to assign a risk tier
2. **Insure** — Agent buys a policy on-chain; premium auto-calculated by tier
3. **Monitor** — Helius webhooks and Pyth oracles watch transactions 24/7
4. **Payout** — Trigger fires → claim verified on-chain → USDC transferred instantly

## Quick Start

```bash
git clone https://github.com/mihailShumilov/ai-agent-insurance.git
cd ai-agent-insurance
bash scripts/setup-local.sh
pnpm dev
```

This starts PostgreSQL, Redis, Backend API (port 4099), Frontend (port 3099), and background workers.

## Architecture

```
packages/
  anchor/   — Solana program (Rust, Anchor 0.30.1)
  api/      — Backend (Fastify 5, Drizzle ORM, BullMQ)
  web/      — Frontend (Next.js 16, React 19)
  sdk/      — Solana Agent Kit plugin (TypeScript)
  shared/   — Cross-package types, constants, utilities
```

## Tech Stack

Solana (Anchor 0.30.1) · Next.js 16 · Fastify 5 · PostgreSQL 18 · Helius · Pyth · Solana Agent Kit

## Coverage Triggers

| Trigger | Condition | Lock Period |
|---------|-----------|-------------|
| Smart Contract Exploit | Balance drop >50% in single slot | 0 hours |
| Oracle Manipulation | Price deviation >5% from TWAP | 1 hour |
| Critical Agent Error | Transfer >100x agent average | 6 hours |
| Governance Attack | Admin key change + drain within 30m | 2 hours |

## Risk Tiers

| Tier | Annual Premium | Score Range |
|------|---------------|-------------|
| LOW | 1.0% | 0 — 0.25 |
| MEDIUM | 2.5% | 0.25 — 0.50 |
| HIGH | 5.0% | 0.50 — 0.75 |
| EXTREME | Declined | 0.75+ |

## Development

```bash
pnpm dev              # Start all (docker + api + web)
pnpm build            # Build all packages
pnpm test             # Run all tests
pnpm test:anchor      # Anchor tests only
pnpm docker:up/down   # Manage Docker services
```

## License

MIT
