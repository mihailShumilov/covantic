#!/usr/bin/env bash
set -euo pipefail

# Covantic — One-line server setup
# Usage (on a fresh Ubuntu server):
#   curl -fsSL https://raw.githubusercontent.com/mihailShumilov/ai-agent-insurance/main/scripts/setup-server.sh | bash
# Or after cloning:
#   bash scripts/setup-server.sh

DOMAIN="${DOMAIN:-covantic.org}"
REPO="https://github.com/mihailShumilov/ai-agent-insurance.git"
APP_DIR="${APP_DIR:-/root/covantic}"

echo "================================================"
echo "  Covantic — Server Setup"
echo "  Domain: ${DOMAIN}"
echo "================================================"
echo ""

# ── 1. System dependencies ──────────────────────────────────────
echo "==> [1/8] Installing system dependencies..."
apt update -qq
apt install -y -qq git curl ufw > /dev/null 2>&1

# ── 2. Docker ───────────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
  echo "==> [2/8] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  echo "==> [2/8] Docker already installed: $(docker --version)"
fi

# Verify docker compose
if ! docker compose version &> /dev/null; then
  echo "ERROR: docker compose plugin not found. Install Docker Engine 24+."
  exit 1
fi

# ── 3. Firewall ─────────────────────────────────────────────────
echo "==> [3/8] Configuring firewall..."
ufw allow 22/tcp > /dev/null 2>&1
ufw allow 80/tcp > /dev/null 2>&1
ufw allow 443/tcp > /dev/null 2>&1
echo "y" | ufw enable > /dev/null 2>&1 || true
echo "     Firewall: SSH(22), HTTP(80), HTTPS(443) open"

# ── 4. Clone repository ────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "==> [4/8] Repository exists, pulling latest..."
  cd "$APP_DIR"
  git pull --ff-only
else
  echo "==> [4/8] Cloning repository..."
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# ── 5. Environment file ────────────────────────────────────────
if [ ! -f .env ]; then
  echo "==> [5/8] Creating .env from template..."
  cp .env.production.example .env

  # Generate strong DB password
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
  read -p "  Press ENTER after editing .env (or Ctrl+C to abort)... "
else
  echo "==> [5/8] .env already exists, skipping"
fi

# ── 6. Oracle keypair ──────────────────────────────────────────
if [ ! -f docker/keys/oracle-keypair.json ]; then
  echo "==> [6/8] Oracle keypair not found"
  echo ""
  echo "  Copy it from your local machine:"
  echo "  scp keys/oracle-keypair.json root@SERVER_IP:${APP_DIR}/docker/keys/"
  echo ""
  mkdir -p docker/keys
  read -p "  Press ENTER after copying (or Ctrl+C to set up later)... "
else
  echo "==> [6/8] Oracle keypair found"
fi

# ── 7. Build and start services ────────────────────────────────
COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"

echo "==> [7/8] Building Docker images (this takes a few minutes)..."
$COMPOSE build

echo "==> [7/8] Starting database services..."
$COMPOSE up -d postgres redis
echo "     Waiting for database to be ready..."
sleep 8

echo "==> [7/8] Pushing database schema..."
$COMPOSE run --rm api sh -c 'npx drizzle-kit push --force'

echo "==> [7/8] Starting all services..."
$COMPOSE up -d

# ── 8. SSL setup ───────────────────────────────────────────────
echo "==> [8/8] Setting up SSL for ${DOMAIN}..."
echo ""
echo "  Make sure DNS A record for ${DOMAIN} points to this server's IP."
echo ""
read -p "  Press ENTER to request SSL certificate (or Ctrl+C to skip)... "

DOMAIN="${DOMAIN}" bash scripts/setup-ssl.sh

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
echo "  docker compose -f docker/docker-compose.prod.yml --env-file .env logs -f  # logs"
echo ""
