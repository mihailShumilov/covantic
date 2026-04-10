# Covantic — Hetzner VDS Deployment

## 1. VDS Initial Setup

```bash
# SSH into your VDS
ssh root@YOUR_VDS_IP

# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Install Docker Compose plugin (included with Docker Engine 24+)
docker compose version  # verify

# Install Git
apt install -y git

# Create app user (optional, recommended)
adduser --disabled-password covantic
usermod -aG docker covantic
su - covantic
```

## 2. Clone & Configure

```bash
# Clone the repo
git clone https://github.com/mihailShumilov/ai-agent-insurance.git covantic
cd covantic

# Create production .env
cp .env.production.example .env
nano .env  # fill in real values

# Generate strong DB password
openssl rand -base64 32  # use this for POSTGRES_PASSWORD

# Copy oracle keypair
mkdir -p docker/keys
# scp from local: scp keys/oracle-keypair.json covantic@VDS_IP:~/covantic/docker/keys/
```

## 3. First Deploy

```bash
# Build and start everything (without SSL first)
docker compose -f docker/docker-compose.prod.yml up -d postgres redis
sleep 5  # wait for DB

# Push database schema
docker compose -f docker/docker-compose.prod.yml run --rm api sh -c \
  'npx drizzle-kit push --force'

# Seed demo data (optional)
docker compose -f docker/docker-compose.prod.yml run --rm api sh -c \
  'node -e "import(\"./dist/db/seed.js\")"'

# Start all services
docker compose -f docker/docker-compose.prod.yml up -d
```

## 4. SSL Certificate (Let's Encrypt)

```bash
# Point your domain DNS A record to VDS IP first, then:
DOMAIN=covantic.xyz bash scripts/setup-ssl.sh
```

**Manual method** (if script doesn't work):

```bash
# 1. Copy initial HTTP config
cp docker/nginx/conf.d/initial.conf docker/nginx/conf.d/active.conf
sed -i 's/YOUR_DOMAIN.com/covantic.xyz/g' docker/nginx/conf.d/active.conf

# 2. Start nginx
docker compose -f docker/docker-compose.prod.yml up -d nginx

# 3. Get certificate
docker compose -f docker/docker-compose.prod.yml run --rm certbot \
  certbot certonly --webroot -w /var/www/certbot \
  --email admin@covantic.xyz --agree-tos --no-eff-email \
  -d covantic.xyz

# 4. Switch to SSL config
rm docker/nginx/conf.d/active.conf
cp docker/nginx/conf.d/covantic.conf docker/nginx/conf.d/active.conf
sed -i 's/YOUR_DOMAIN.com/covantic.xyz/g' docker/nginx/conf.d/active.conf

# 5. Reload nginx
docker compose -f docker/docker-compose.prod.yml exec nginx nginx -s reload
```

SSL auto-renews via the certbot container (checks every 12h).

## 5. Apply Updates & Restart

### Quick update (rebuild changed services only):

```bash
cd ~/covantic
git pull --ff-only

# Rebuild and restart only what changed
docker compose -f docker/docker-compose.prod.yml build api web monitor
docker compose -f docker/docker-compose.prod.yml up -d api web monitor

# Clean old images
docker image prune -f
```

### Full redeploy:

```bash
bash scripts/deploy.sh
```

### Restart without rebuild:

```bash
docker compose -f docker/docker-compose.prod.yml restart api web monitor
```

### Restart single service:

```bash
docker compose -f docker/docker-compose.prod.yml restart api
```

## 6. Database Operations

```bash
COMPOSE="docker compose -f docker/docker-compose.prod.yml"

# Push schema changes
$COMPOSE run --rm api sh -c 'npx drizzle-kit push --force'

# Seed data
$COMPOSE run --rm api sh -c 'node -e "import(\"./dist/db/seed.js\")"'

# Connect to DB directly
$COMPOSE exec postgres psql -U covantic -d covantic

# Backup
$COMPOSE exec postgres pg_dump -U covantic covantic > backup_$(date +%Y%m%d).sql

# Restore
cat backup_20260410.sql | $COMPOSE exec -T postgres psql -U covantic -d covantic
```

## 7. Logs & Monitoring

```bash
COMPOSE="docker compose -f docker/docker-compose.prod.yml"

# All logs
$COMPOSE logs -f

# Specific service
$COMPOSE logs -f api
$COMPOSE logs -f web
$COMPOSE logs -f monitor
$COMPOSE logs -f nginx

# Last 100 lines
$COMPOSE logs --tail 100 api

# Service status
$COMPOSE ps
```

## 8. Firewall

```bash
# Allow only HTTP, HTTPS, SSH
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Verify — only these ports should be open
ufw status
```

**Important**: PostgreSQL (5432) and Redis (6379) are NOT exposed to the host in production — they're only accessible within the Docker network.

## 9. Troubleshooting

| Problem | Fix |
|---------|-----|
| API 500 errors | `docker compose logs api` — check DB connection |
| Nginx 502 | Service not ready — `docker compose ps`, rebuild if needed |
| SSL cert expired | `docker compose exec certbot certbot renew --force-renewal` then `docker compose exec nginx nginx -s reload` |
| Out of disk | `docker system prune -a` (removes all unused images) |
| DB migration fail | `docker compose exec postgres psql -U covantic -d covantic` to debug |
| Container won't start | `docker compose logs <service>` — check for env var issues |

## Architecture (Production)

```
Internet
  │
  ▼
┌─────────────────────────┐
│  Nginx (:80, :443)      │
│  SSL termination        │
│  Rate limiting          │
└──┬──────────┬───────────┘
   │          │
   ▼          ▼
┌──────┐  ┌──────┐
│ Web  │  │ API  │◄── Monitor
│:3000 │  │:4000 │
└──────┘  └──┬───┘
             │
     ┌───────┴───────┐
     ▼               ▼
┌──────────┐  ┌──────────┐
│ Postgres │  │  Redis   │
│  :5432   │  │  :6379   │
└──────────┘  └──────────┘
(internal network only)
```
