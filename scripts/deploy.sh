#!/usr/bin/env bash
set -euo pipefail

# Covantic — Deploy / Update script
# Usage: bash scripts/deploy.sh

COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$APP_DIR"

echo "==> Pulling latest code..."
git pull --ff-only

echo "==> Building images..."
$COMPOSE build --no-cache

echo "==> Pushing database schema..."
$COMPOSE run --rm api sh -c \
  'DATABASE_URL=$DATABASE_URL npx drizzle-kit push --force'

echo "==> Restarting services..."
$COMPOSE down
$COMPOSE up -d

echo "==> Waiting for health checks..."
sleep 5
$COMPOSE ps

echo "==> Cleaning old images..."
docker image prune -f

echo "==> Done. Services:"
$COMPOSE ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
