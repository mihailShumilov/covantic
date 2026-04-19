# Local Development Guide

## Requirements

- Node.js 22+
- pnpm 9+
- Docker 27+
- Rust (stable)
- Solana CLI 2.x
- Anchor CLI 0.30.x

## Quick Start

From the monorepo root:

```bash
pnpm install
bash scripts/setup-local.sh     # docker up, .env from template, oracle keypair, db migrate
pnpm init:devnet                # anchor build + deploy, create devnet USDC, init config/vault
pnpm fund:phantom <WALLET> 1000 # (optional) mint test-USDC to a browser wallet
pnpm dev                        # docker + api:4099 + web:3099 + workers
```

`pnpm dev` starts:

- PostgreSQL 18 (port 5499)
- Redis 7 (port 6399)
- Backend API (port 4099)
- Frontend (port 3099)
- Background workers: `expiry-crank` (on-chain), `solvency-checker`, `analytics-aggregator`,
  `policy-indexer`, `claim-keeper`

`init:devnet` is idempotent — re-running it just confirms the program is deployed and the
config PDA already exists.

## Manual Setup

### Database

```bash
docker compose -f docker/docker-compose.yml up -d postgres redis
pnpm --filter api run db:push
pnpm --filter api run db:seed    # optional demo data
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

Copy `.env.example` to `.env`. `setup-local.sh` + `init:devnet` populate most of it; you only need
to supply third-party keys.

| Var | Purpose |
| --- | --- |
| `SOLANA_RPC_URL`, `SOLANA_NETWORK` | Devnet RPC and network label |
| `PROGRAM_ID` | Written by `init:devnet` |
| `USDC_MINT` | Written by `init:devnet` on first run |
| `ORACLE_KEYPAIR_PATH` | Default `./keys/oracle-keypair.json` — signs `upsert_attestation`, `oracle_submit_claim`, `verify_and_payout`, and the on-chain `expire_policy` crank |
| `HELIUS_API_KEY` | https://dev.helius.xyz/ |
| `HELIUS_WEBHOOK_SECRET` | 64+ chars. The `/api/monitoring/webhook` endpoint accepts either HMAC-of-body or `Authorization: Bearer <secret>` — real Helius deliveries use the bearer path |
| `WEBHOOK_PUBLIC_URL` | Only required when running `pnpm webhook:sync` (e.g. an ngrok / Cloudflare Tunnel URL) |
| `ALERT_HMAC_SECRET` | HMAC secret for the internal `monitoring:alerts` Redis channel; the claim-keeper rejects unsigned alerts |
| `DATABASE_URL`, `REDIS_URL`, `PORT` | Dev defaults from the docker-compose + `.env.example` |
| `NEXT_PUBLIC_*` | Mirrors of the above that reach the browser |

## Useful Scripts

| Script | Purpose |
| --- | --- |
| `pnpm init:devnet` | Build + deploy + init. Safe to re-run. |
| `pnpm fund:phantom <wallet> [amount]` | Mint mock USDC to a wallet (mint authority = oracle keypair) |
| `pnpm webhook:sync` | Register/update the Helius webhook over every insured agent address. Requires `WEBHOOK_PUBLIC_URL`. |
| `pnpm agent:create --name X` | Generate `keys/agents/X.json` and print the dashboard URL for insuring it |
| `pnpm agent:fund --name X [--sol 0.5] [--usdc 5000]` | Airdrop SOL + mint mock USDC to the agent |
| `pnpm agent:trigger --name X [--amount 2000]` | Sign and broadcast a real SPL-USDC transfer (> 1,000 USDC triggers the monitor) |
| `pnpm fleet:bootstrap [--count 5] [--coverage 200]` | Create N funded agents + holder keypair, assess risk, buy policies, write `keys/fleet.json` |
| `pnpm fleet:start` | Run the fleet loop (safe / skip / rogue / failing txs every 45–90 s) |
| `pnpm fleet:status` | Print current fleet manifest + recent activity |
| `pnpm stake:vault [--amount N]` | Stake USDC into the vault (raises solvency ratio so `fleet:bootstrap` can add more policies without hitting `SolvencyTooLow`) |
| `pnpm exec tsx scripts/smoke-auto-claim.ts` | End-to-end smoke: simulate → on-chain paid state |

## Demo Walkthrough

See [`docs/MANUAL_DEMO.md`](MANUAL_DEMO.md) for a full UI + CLI walkthrough.

## Troubleshooting

### Port 5499 / 6399 already in use

```bash
docker compose -f docker/docker-compose.yml down
```

### "Program not found"

```bash
pnpm init:devnet   # rebuilds + redeploys + writes PROGRAM_ID to .env
```

### "Migration failed" / schema drift

```bash
docker compose -f docker/docker-compose.yml down -v
docker compose -f docker/docker-compose.yml up -d postgres
pnpm --filter api run db:push
```

### Stuck "Active" policy past expiry

The expiry-crank is on-chain. If a policy stays Active past its expiry:

```bash
curl http://localhost:4099/api/policies/<id>/why-active
curl http://localhost:4099/api/monitoring/metrics       # look at policyLag.stuckCount
```

`onChainReason: owner-mismatch` after a redeploy = stale DB row, corrected on the next
`policy-indexer` tick. Other reasons are documented in `docs/API.md`.

### Helius webhook 401

The webhook requires either HMAC-of-body or `Authorization: Bearer <HELIUS_WEBHOOK_SECRET>`.
For real Helius deliveries, register via `pnpm webhook:sync` (ensure `WEBHOOK_PUBLIC_URL` is
set to a public URL pointing at `/api/monitoring/webhook`).
