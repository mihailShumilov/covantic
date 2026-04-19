# Covantic

**The coverage primitive for autonomous agents.**

Covantic is the first parametric insurance protocol for AI agents on Solana. Agents purchase coverage before DeFi operations. When a covered event occurs — exploit, oracle manipulation, critical error — the protocol verifies the claim on-chain and pays out instantly. No human review. No paperwork.

> Built for [Colosseum Frontier Hackathon](https://colosseum.org) — April–May 2026

## How It Works

1. **Assess** — AI Risk Scorer analyzes 7 on-chain factors to assign a tier (LOW / MEDIUM / HIGH / EXTREME-uninsurable)
2. **Attest** — The oracle signs an on-chain `RiskAttestation` PDA for the agent; `create_policy` reads the tier from it so buyers cannot self-select a cheaper tier
3. **Insure** — Holder buys a policy on-chain; premium auto-calculated from the attested tier
4. **Monitor** — Helius webhooks detect anomalies on insured agent addresses; the claim-keeper drives submit + payout
5. **Payout** — Trigger fires → `oracle_submit_claim` → lock period → `verify_and_payout` → USDC transferred to holder's ATA

## Quick Start

```bash
git clone https://github.com/mihailShumilov/ai-agent-insurance.git
cd ai-agent-insurance
bash scripts/setup-local.sh        # docker up, .env, oracle keypair, db migrate
pnpm init:devnet                   # anchor build + deploy, create devnet USDC, init config/vault
pnpm fund:phantom <WALLET> 1000    # mint test USDC to your browser wallet
pnpm dev                           # docker + api:4099 + web:3099 + workers
```

This starts PostgreSQL (5499), Redis (6399), Backend API (4099), Frontend (3099), and background workers
(expiry-crank, solvency-checker, analytics-aggregator, policy-indexer, claim-keeper).

For a full end-to-end walkthrough including buying policies, simulating incidents, and the autonomous
agent fleet, see [`docs/MANUAL_DEMO.md`](docs/MANUAL_DEMO.md).

> The Solana Agent Kit plugin lives in a separate repo: [`covantic-solana-sdk`](https://github.com/mihailShumilov/covantic-solana-sdk).

## Architecture

```
packages/
  anchor/   — Solana program (Rust, Anchor 0.30.1)
  api/      — Backend (Fastify 5, Drizzle ORM, BullMQ)
  web/      — Frontend (Next.js 16, React 19)
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
pnpm dev                 # Start all (docker + api + web)
pnpm build               # Build all packages
pnpm test                # Run all tests
pnpm test:anchor         # Anchor tests only
pnpm docker:up/down      # Manage Docker services
pnpm init:devnet         # Build + deploy + initialize the Anchor program on devnet
pnpm fund:phantom <addr> [amount]    # Mint devnet test-USDC to a wallet
pnpm webhook:sync        # Register/refresh the Helius webhook for all insured agents
pnpm agent:create|fund|trigger       # Throwaway agent keypair CLI for real on-chain activity
pnpm fleet:bootstrap|start|status    # Autonomous fleet of policy-covered agents
```

## Related Docs

- [`docs/MANUAL_DEMO.md`](docs/MANUAL_DEMO.md) — end-to-end demo & QA walkthrough
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — component + data-flow overview
- [`docs/API.md`](docs/API.md) — HTTP + WebSocket reference
- [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md) — local setup & troubleshooting
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production deploy playbook

## License

MIT
