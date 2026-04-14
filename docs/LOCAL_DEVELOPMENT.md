# Local Development Guide

## Requirements

- Node.js 22+
- pnpm 9+
- Docker 27+
- Rust (stable)
- Solana CLI 2.x
- Anchor CLI

## Quick Start (2 commands)

### Command 1: Setup

```bash
bash scripts/setup-local.sh
```

### Command 2: Start

```bash
pnpm dev
```

This starts:

- PostgreSQL 18 (port 5499)
- Redis 7 (port 6399)
- Backend API (port 4099)
- Frontend (port 3099)
- Background workers (expiry, solvency, analytics, policy indexer, claim keeper)

## Manual Setup

### Database

```bash
docker compose -f docker/docker-compose.yml up -d postgres redis
pnpm --filter api run db:push
pnpm --filter api run db:seed
```

### Backend

```bash
pnpm --filter api dev
```

### Frontend

```bash
pnpm --filter web dev
```

### Anchor

```bash
cd packages/anchor
anchor build
anchor test
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:

- `HELIUS_API_KEY`: get at https://dev.helius.xyz/
- Other values are pre-configured for local development

## Troubleshooting

### "Port 5499 already in use"

```bash
docker compose -f docker/docker-compose.yml down
```

### "Program not found"

```bash
cd packages/anchor && anchor build
```

Update PROGRAM_ID in .env

### "Migration failed"

```bash
docker compose -f docker/docker-compose.yml down -v
docker compose -f docker/docker-compose.yml up -d postgres
pnpm --filter api run db:push
```
