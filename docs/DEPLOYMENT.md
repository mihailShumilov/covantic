# Covantic — Production Deployment

Domain: **covantic.org**

## Quick Start (One Command)

SSH into a fresh Ubuntu server and run:

```bash
git clone https://github.com/mihailShumilov/ai-agent-insurance.git covantic
cd covantic
bash scripts/setup-server.sh
```

The script will:

1. Install Docker, Git, and configure the firewall
2. Clone the repo (or pull latest)
3. Generate `.env` with a strong DB password — pauses for you to fill in API keys
4. Prompt for oracle keypair
5. Build all Docker images
6. Start PostgreSQL + Redis, push the DB schema
7. Start all services (API, Web, Monitor, Nginx)
8. Request an SSL certificate via Let's Encrypt

## What You Need Before Starting

| Item                       | Where to get it                                 |
| -------------------------- | ----------------------------------------------- |
| Ubuntu VDS (Hetzner, etc.) | Any provider with Docker support                |
| Domain DNS A record        | Point `covantic.org` → server IP                |
| Helius API key             | https://dev.helius.xyz/                         |
| Oracle keypair             | `solana-keygen new -o keys/oracle-keypair.json` |
| USDC mint (devnet)         | Created by `scripts/setup-local.sh` or manually |

## Manual Setup (Step by Step)

### 1. Server Prerequisites

```bash
ssh root@YOUR_SERVER_IP

apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
systemctl enable docker && systemctl start docker
apt install -y git
```

### 2. Clone & Configure

```bash
git clone https://github.com/mihailShumilov/ai-agent-insurance.git covantic
cd covantic

# Create .env from template
cp .env.production.example .env
nano .env
```

**Required `.env` changes:**

```bash
# Generate strong secrets
openssl rand -base64 32     # POSTGRES_PASSWORD
openssl rand -hex 32        # HELIUS_WEBHOOK_SECRET (≥ 64 chars after hex encoding)
openssl rand -hex 32        # ALERT_HMAC_SECRET (internal alert bus signing)
openssl rand -base64 32     # REDIS_PASSWORD

# Update these in .env:
POSTGRES_PASSWORD=<generated-password>
REDIS_PASSWORD=<generated-password>
HELIUS_API_KEY=<your-key>
HELIUS_WEBHOOK_SECRET=<generated-secret>     # accepted as Authorization: Bearer <secret> from Helius
ALERT_HMAC_SECRET=<generated-secret>         # signs internal monitoring:alerts channel
SOLANA_RPC_FALLBACK_URLS=<second https endpoint on the SAME cluster>   # comma-separated
TRUST_PROXY=1                                # hop count, never `true` — see below
HELIUS_WEBHOOK_BEARER=<generated-secret>     # separate from HELIUS_WEBHOOK_SECRET, and gates /api/health/rpc detail
FLEET_SINK_ADDRESS=<oracle authority pubkey> # so the fleet container needs no oracle secret
USDC_MINT=<your-devnet-usdc-mint>
PROGRAM_ID=<devnet-program-id>
ORACLE_KEYPAIR_PATH=/app/keys/oracle-keypair.json
WEBHOOK_PUBLIC_URL=https://covantic.org      # points at /api/monitoring/webhook after sync
NEXT_PUBLIC_API_URL=https://covantic.org
NEXT_PUBLIC_WS_URL=wss://covantic.org
```

Copy oracle keypair:

```bash
mkdir -p docker/keys
# From your local machine:
scp keys/oracle-keypair.json root@SERVER_IP:~/covantic/docker/keys/
```

The oracle keypair signs `upsert_attestation`, `oracle_submit_claim`, `verify_and_payout`, and the
on-chain `expire_policy` crank — it must be funded with SOL on the target network.

### 3. Build & Start

```bash
COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"

# Build all images
$COMPOSE build

# Start DB first
$COMPOSE up -d postgres redis
sleep 8

# Push schema
$COMPOSE run --rm api sh -c 'npx drizzle-kit push --force'

# Start everything
$COMPOSE up -d
```

### 4. SSL Certificate

Point DNS A record for `covantic.org` to the server IP, then:

```bash
DOMAIN=covantic.org bash scripts/setup-ssl.sh
```

**Manual SSL method** (if script fails):

```bash
COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"

# 1. HTTP-only nginx for cert provisioning
cp docker/nginx/conf.d/http.conf.template docker/nginx/conf.d/active.conf
sed -i 's/YOUR_DOMAIN.com/covantic.org/g' docker/nginx/conf.d/active.conf
$COMPOSE up -d nginx

# 2. Request certificate
$COMPOSE run --rm certbot \
  certbot certonly --webroot -w /var/www/certbot \
  --email admin@covantic.org --agree-tos --no-eff-email \
  -d covantic.org

# 3. Switch to SSL config
rm docker/nginx/conf.d/active.conf
cp docker/nginx/conf.d/ssl.conf.template docker/nginx/conf.d/active.conf
sed -i 's/YOUR_DOMAIN.com/covantic.org/g' docker/nginx/conf.d/active.conf

# 4. Reload
$COMPOSE exec nginx nginx -s reload
```

SSL auto-renews via the certbot container (checks every 12h).

### 5. Register the Helius webhook

Once the domain is live, register the production webhook so Helius starts delivering events:

```bash
$COMPOSE exec api pnpm --filter api exec tsx scripts/sync-helius-webhook.ts
```

The script reads every distinct `agent_address` from the `policies` table (state=Active),
creates or edits the single Helius webhook tied to this deployment, and sets the
`Authorization: Bearer <HELIUS_WEBHOOK_SECRET>` header the API validates. Re-run whenever
you add new insured agents — the call is idempotent.

### 6. Firewall

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

PostgreSQL (5432) and Redis (6379) are NOT exposed — only accessible within the Docker network.

## Operations

### Update & Redeploy

**One command** (pulls, builds, migrates, restarts):

```bash
bash scripts/deploy.sh
```

**Quick update** (rebuild only changed services):

```bash
cd ~/covantic
git pull --ff-only
COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"
$COMPOSE build api web monitor fleet
$COMPOSE up -d api web monitor fleet
docker image prune -f
```

**Restart without rebuild:**

```bash
docker compose -f docker/docker-compose.prod.yml --env-file .env restart api web monitor
```

**Restart single service:**

```bash
docker compose -f docker/docker-compose.prod.yml --env-file .env restart api
```

### Images

Four are built from this repo: `api`, `monitor`, `web` and `fleet`. The fleet
has its own Dockerfile rather than reusing the api image — it runs a
TypeScript entrypoint through `tsx`, so it needs devDependencies the api image
now prunes, and it is the least-trusted process in the stack (it drives
throwaway agents and deliberately lands malformed transactions), which is a
poor thing to share an image with the claim keeper. Base images are pinned by
digest, so a rebuild months later is the same base; bump it deliberately with
`docker manifest inspect node:22-alpine`.

### RPC endpoints

Chain **reads** fan out across `SOLANA_RPC_URL` plus every URL in
`SOLANA_RPC_FALLBACK_URLS`, in that order. Chain **writes** — every
transaction this service sends, including the two checkpoint instructions —
stay on `SOLANA_RPC_URL` alone, so that endpoint must remain a working,
funded provider even when the fallbacks are carrying the read load.

Running with no fallback is the old single-endpoint behaviour, and it is worse
than a latency problem: when the provider hits its quota the exploit watcher
stops writing balance checkpoints, and an exploit or agent-error claim filed
without a fresh checkpoint is settled **`failed`, not `review`**. Set at least
one fallback.

An endpoint that fails three times in a row leaves the rotation for 30 s — or
5 minutes if it answered `429` — and is skipped with no network call until
then, so a throttled provider gets a chance to recover instead of being
hammered.

```bash
# Per-endpoint state: health, slot, latency, error rate, cooldown, 429 count
curl -s https://covantic.org/api/health/rpc | jq
```

`status: "no-endpoint-available"` means every endpoint is either unhealthy or
in cooldown. Endpoint slots are sampled on a 30-second timer, so `healthy`
means "answering, and not more than 150 slots behind the freshest endpoint" —
not merely "has not failed three times". The response never carries a URL,
only the host name: provider API keys live in the query string.

Per-endpoint detail requires the operator bearer token
(`HELIUS_WEBHOOK_BEARER`, falling back to `HELIUS_WEBHOOK_SECRET`); an
anonymous caller gets the aggregate verdict only. `rateLimited` and `tripped`
are a live success signal for a quota-exhaustion attack, and
`no-endpoint-available` announces the window in which nothing is being
checkpointed:

```bash
curl -s -H "Authorization: Bearer $HELIUS_WEBHOOK_BEARER" \
  https://covantic.org/api/health/rpc | jq
```

Reads that can **close** a claim — a holder's governance baseline or agent
mandate — are read from two endpoints and must agree. The proof instructions
bound what an endpoint can take, because each re-derives the payout from state
the program reads itself; nothing bounds what one can *deny*, and a rejection
is computed off chain and is terminal. A disagreement throws, which resolves
the claim to review rather than to a wrong verdict. With a single endpoint
configured there is nothing to compare against and the read proceeds alone —
the trust assumption is then what it was before fallbacks existed.

Every endpoint's cluster is checked once at boot. A fallback on the wrong
cluster is ejected permanently and logged at `error`; a **primary** on the
wrong cluster refuses the process, because that is also where every
transaction is sent.

### Database

```bash
COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"

# Push schema changes
$COMPOSE run --rm api sh -c 'npx drizzle-kit push --force'

# Seed data
$COMPOSE run --rm api sh -c 'node -e "import(\"./dist/db/seed.js\")"'

# Connect to DB
$COMPOSE exec postgres psql -U covantic -d covantic

# Backup
$COMPOSE exec postgres pg_dump -U covantic covantic > backup_$(date +%Y%m%d).sql

# Restore
cat backup.sql | $COMPOSE exec -T postgres psql -U covantic -d covantic
```

### Logs

```bash
COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"

$COMPOSE logs -f              # all services
$COMPOSE logs -f api          # single service
$COMPOSE logs --tail 100 api  # last 100 lines
$COMPOSE ps                   # service status
```

## Troubleshooting

| Problem                                                              | Fix                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API 500 errors                                                       | `$COMPOSE logs api` — check DB connection                                                                                                                                                                                                                                                                                            |
| Nginx 502                                                            | Service not ready — `$COMPOSE ps`, rebuild if needed                                                                                                                                                                                                                                                                                 |
| SSL cert expired                                                     | `$COMPOSE exec certbot certbot renew --force-renewal` then `$COMPOSE exec nginx nginx -s reload`                                                                                                                                                                                                                                     |
| Out of disk                                                          | `docker system prune -a` (removes all unused images)                                                                                                                                                                                                                                                                                 |
| DB migration fail                                                    | `$COMPOSE exec postgres psql -U covantic -d covantic` to debug                                                                                                                                                                                                                                                                       |
| Container won't start                                                | `$COMPOSE logs <service>` — check for env var issues                                                                                                                                                                                                                                                                                 |
| Build fails (node-gyp)                                               | Dockerfile.web includes `python3 make g++ linux-headers eudev-dev` — ensure it's up to date                                                                                                                                                                                                                                          |
| Helius webhook 401                                                   | Token mismatch between Helius and `HELIUS_WEBHOOK_SECRET`. Re-run `sync-helius-webhook.ts` after rotating the secret.                                                                                                                                                                                                                |
| Insured events not firing claims                                     | `curl https://covantic.org/api/monitoring/metrics` — if `monitor.matched:active` stays 0, the webhook or its address list is wrong. Re-run the sync script.                                                                                                                                                                          |
| Policies stuck as `Active` past expiry                               | `curl .../api/policies/<id>/why-active` — `owner-mismatch` = stale DB row, auto-heals on next indexer tick. `rpc-error` = RPC flaky; check oracle wallet SOL balance (expiry-crank signer).                                                                                                                                          |
| Claim never pays out after trigger                                   | Check `ALERT_HMAC_SECRET` matches across monitor + api + claim-keeper containers; unsigned alerts are dropped silently.                                                                                                                                                                                                              |
| `AccountDidNotDeserialize` (3003) on `vault` after a program upgrade | The upgrade grew an account layout while the on-chain accounts are still the old size, so `Account<T>` fails during `try_accounts` before any handler runs — every instruction taking the vault is dead, `create_policy` included. Run `pnpm migrate:accounts --keypair <upgrade-authority>`. Idempotent, and part of every upgrade. |
| `EACCES` opening `/app/keys/*.json`                                  | The api/monitor/fleet containers run as `node` (uid 1000), and the key material is mounted from `docker/keys`. `chown -R 1000:1000 docker/keys` — chown only, leave the `0600` alone.                                                                                                                                                |
| A `*_PROOF_ENABLED` flag has no effect                               | There is no `env_file` in the compose stack: a variable reaches a container only if it is named in that service's `environment:` block. Setting one in `.env` alone changes nothing.                                                                                                                                                 |
| Oracle wallet out of SOL                                             | On-chain crank (expire_policy) and attestation publisher need gas. Top up with `solana airdrop` on devnet or send SOL on mainnet.                                                                                                                                                                                                    |

## Architecture

```
Internet
  |
  v
+-------------------------+
|  Nginx (:80, :443)      |
|  SSL termination        |
|  Rate limiting          |
+--+----------+-----------+
   |          |
   v          v
+------+  +------+
| Web  |  | API  |<-- Monitor
|:3000 |  |:4000 |
+------+  +--+---+
             |
     +-------+-------+
     v               v
+----------+  +----------+
| Postgres |  |  Redis   |
|  :5432   |  |  :6379   |
+----------+  +----------+
(internal network only)
```
