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

| Item | Where to get it |
|------|----------------|
| Ubuntu VDS (Hetzner, etc.) | Any provider with Docker support |
| Domain DNS A record | Point `covantic.org` → server IP |
| Helius API key | https://dev.helius.xyz/ |
| Oracle keypair | `solana-keygen new -o keys/oracle-keypair.json` |
| USDC mint (devnet) | Created by `scripts/setup-local.sh` or manually |

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
$COMPOSE build api web monitor
$COMPOSE up -d api web monitor
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

| Problem | Fix |
|---------|-----|
| API 500 errors | `$COMPOSE logs api` — check DB connection |
| Nginx 502 | Service not ready — `$COMPOSE ps`, rebuild if needed |
| SSL cert expired | `$COMPOSE exec certbot certbot renew --force-renewal` then `$COMPOSE exec nginx nginx -s reload` |
| Out of disk | `docker system prune -a` (removes all unused images) |
| DB migration fail | `$COMPOSE exec postgres psql -U covantic -d covantic` to debug |
| Container won't start | `$COMPOSE logs <service>` — check for env var issues |
| Build fails (node-gyp) | Dockerfile.web includes `python3 make g++ linux-headers eudev-dev` — ensure it's up to date |
| Helius webhook 401 | Token mismatch between Helius and `HELIUS_WEBHOOK_SECRET`. Re-run `sync-helius-webhook.ts` after rotating the secret. |
| Insured events not firing claims | `curl https://covantic.org/api/monitoring/metrics` — if `monitor.matched:active` stays 0, the webhook or its address list is wrong. Re-run the sync script. |
| Policies stuck as `Active` past expiry | `curl .../api/policies/<id>/why-active` — `owner-mismatch` = stale DB row, auto-heals on next indexer tick. `rpc-error` = RPC flaky; check oracle wallet SOL balance (expiry-crank signer). |
| Claim never pays out after trigger | Check `ALERT_HMAC_SECRET` matches across monitor + api + claim-keeper containers; unsigned alerts are dropped silently. |
| Oracle wallet out of SOL | On-chain crank (expire_policy) and attestation publisher need gas. Top up with `solana airdrop` on devnet or send SOL on mainnet. |

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
