#!/bin/sh
set -eu

# Covantic — Server Setup
# Run from the project root: bash scripts/setup-server.sh

DOMAIN="${DOMAIN:-covantic.org}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$APP_DIR"

echo "================================================"
echo "  Covantic — Server Setup"
echo "  Domain: ${DOMAIN}"
echo "  Directory: ${APP_DIR}"
echo "================================================"
echo ""

# ── 1. System dependencies ──────────────────────────────────────
echo "==> [1/7] Installing system dependencies..."
apt update -qq
apt install -y -qq git curl ufw openssl > /dev/null 2>&1

# ── 2. Docker ───────────────────────────────────────────────────
if ! command -v docker > /dev/null 2>&1; then
  echo "==> [2/7] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  echo "==> [2/7] Docker already installed: $(docker --version)"
fi

if ! docker compose version > /dev/null 2>&1; then
  echo "ERROR: docker compose plugin not found. Install Docker Engine 24+."
  exit 1
fi

# ── 3. Firewall ─────────────────────────────────────────────────
echo "==> [3/7] Configuring firewall..."
ufw allow 22/tcp > /dev/null 2>&1
ufw allow 80/tcp > /dev/null 2>&1
ufw allow 443/tcp > /dev/null 2>&1
echo "y" | ufw enable > /dev/null 2>&1 || true
echo "     Firewall: SSH(22), HTTP(80), HTTPS(443) open"

# ── 4. Environment file ────────────────────────────────────────
if [ ! -f .env ]; then
  echo "==> [4/7] Creating .env from template..."
  cp .env.production.example .env

  DB_PASS=$(openssl rand -base64 32 | tr -d '=/+' | head -c 32)
  sed -i "s|CHANGE_ME_STRONG_PASSWORD|${DB_PASS}|g" .env
  sed -i "s|DOMAIN=.*|DOMAIN=${DOMAIN}|g" .env
  sed -i "s|NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=https://${DOMAIN}|g" .env
  sed -i "s|NEXT_PUBLIC_WS_URL=.*|NEXT_PUBLIC_WS_URL=wss://${DOMAIN}|g" .env

  echo "     .env created with generated DB password"
  echo ""
  echo "  !! IMPORTANT: Edit .env before continuing !!"
  echo "  !! Fill in: HELIUS_API_KEY, USDC_MINT, HELIUS_WEBHOOK_SECRET !!"
  echo "     nano ${APP_DIR}/.env"
  echo ""
  printf "  Press ENTER after editing .env (or Ctrl+C to abort)... "
  read _
else
  echo "==> [4/7] .env already exists, skipping"
fi

# ── 5. Oracle keypair ──────────────────────────────────────────
mkdir -p docker/keys
if [ ! -f docker/keys/oracle-keypair.json ]; then
  echo "==> [5/7] Oracle keypair not found"
  echo ""
  echo "  Copy it from your local machine:"
  echo "  scp keys/oracle-keypair.json root@SERVER_IP:${APP_DIR}/docker/keys/"
  echo ""
  printf "  Press ENTER after copying (or Ctrl+C to set up later)... "
  read _
else
  echo "==> [5/7] Oracle keypair found"
fi

# ── 6. Build and start services ────────────────────────────────
COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"

echo "==> [6/7] Building Docker images (this takes a few minutes)..."
$COMPOSE build

echo "==> [6/7] Starting database services..."
$COMPOSE up -d postgres redis
echo "     Waiting for database to be ready..."
sleep 8

echo "==> [6/7] Pushing database schema..."
$COMPOSE run --rm api sh -c 'cd packages/api && npx drizzle-kit push --force'

echo "==> [6/7] Starting all services..."
$COMPOSE up -d

# ── 7. SSL setup ───────────────────────────────────────────────
echo "==> [7/7] SSL setup for ${DOMAIN}"
echo ""
echo "  Make sure DNS A record for ${DOMAIN} points to this server's IP."
echo ""
printf "  Press ENTER to request SSL certificate (or Ctrl+C to skip)... "
read _

DOMAIN="${DOMAIN}" sh scripts/setup-ssl.sh

# ── Done ────────────────────────────────────────────────────────
echo ""
echo "================================================"
echo "  Covantic is running!"
echo "  https://${DOMAIN}"
echo "================================================"
echo ""
$COMPOSE ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "Useful commands:"
echo "  cd ${APP_DIR}"
echo "  bash scripts/deploy.sh          # update & redeploy"
echo "  $COMPOSE logs -f                # view logs"
echo ""
