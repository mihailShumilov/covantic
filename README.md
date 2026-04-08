# AgentGuard

**First parametric insurance protocol for AI agents on Solana.**

AI agents buy insurance before DeFi operations. On trigger (exploit, oracle manipulation, agent error, governance attack), automatic verification and payout via on-chain oracle. No human intervention.

## Architecture

```
agentguard/
├── packages/
│   ├── anchor/     # Solana program (Anchor/Rust)
│   ├── api/        # Backend API (Fastify + PostgreSQL + Redis)
│   ├── web/        # Frontend (Next.js + React)
│   ├── sdk/        # Solana Agent Kit Plugin
│   └── shared/     # Shared types and utilities
├── scripts/        # Setup, deploy, and demo scripts
├── docker/         # Docker infrastructure
└── docs/           # Documentation
```

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker 27+
- Rust (stable)
- Solana CLI 2.x
- Anchor CLI

### Setup (2 commands)

```bash
# 1. Full setup
bash scripts/setup-local.sh

# 2. Start everything
pnpm dev
```

This starts:
- **PostgreSQL 18** on port 5432
- **Redis 7** on port 6379
- **Backend API** on port 4000
- **Frontend** on port 3000
- **Background workers** (expiry crank, solvency checker, analytics)

### Environment Variables

Copy `.env.example` to `.env` and fill in:
- `HELIUS_API_KEY` — get at https://dev.helius.xyz/
- `PROGRAM_ID` — generated after `anchor deploy`

## How It Works

### 1. Risk Assessment
AI-powered scoring analyzes agent's on-chain history:
- Failed transaction ratio (20%)
- Average slippage (15%)
- Protocol diversity (15%)
- Transaction volume (20%)
- Wallet age, registry score, token concentration (30%)

Result: **LOW** (1%), **MEDIUM** (2.5%), **HIGH** (5%), or **EXTREME** (declined)

### 2. Policy Creation
- Agent holder pays premium in USDC
- Coverage: 1 USDC — 1M USDC
- Duration: 1 hour — 30 days
- Premium split: 70% stakers, 20% reserve, 10% protocol

### 3. Claim & Payout
Covered triggers:
- **Exploit** — balance drop >50% in 1 slot → immediate payout
- **Oracle Manipulation** — price deviation >5% from TWAP → 1h lock
- **Agent Error** — transfer >100x average → 6h lock
- **Governance Attack** — admin key change + drain → 2h lock

### 4. Staking
- Stake USDC to earn premiums (70% share)
- 48-hour unstake cooldown
- Solvency-based premium multiplier

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contract | Anchor (Rust) on Solana |
| Backend | Fastify, PostgreSQL 18, Redis 7, Drizzle ORM, BullMQ |
| Frontend | Next.js, React, Recharts |
| Monitoring | Helius Enhanced TX, Pyth Price Feeds |
| Agent SDK | Solana Agent Kit Plugin |

## Development

```bash
# Run all tests
pnpm test

# Anchor tests
cd packages/anchor && anchor test

# API tests
pnpm --filter api test

# Deploy to devnet
bash scripts/deploy-devnet.sh

# Database operations
pnpm db:migrate
pnpm db:seed
```

## License

MIT
