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
# Generate a strong DB password
openssl rand -base64 32

# Update these in .env:
POSTGRES_PASSWORD=<generated-password>
HELIUS_API_KEY=<your-key>
HELIUS_WEBHOOK_SECRET=<your-secret>
USDC_MINT=<your-devnet-usdc-mint>
NEXT_PUBLIC_API_URL=https://covantic.org
NEXT_PUBLIC_WS_URL=wss://covantic.org
```

Copy oracle keypair:
```bash
mkdir -p docker/keys
# From your local machine:
scp keys/oracle-keypair.json root@SERVER_IP:~/covantic/docker/keys/
```

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

### 5. Firewall

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
