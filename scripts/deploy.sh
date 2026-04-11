#!/bin/sh
set -eu

# Covantic — Deploy / Update script
# Usage: sh scripts/deploy.sh

COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$APP_DIR"

echo "==> Pulling latest code..."
git pull --ff-only

echo "==> Building images..."
$COMPOSE build --no-cache

echo "==> Pushing database schema..."
$COMPOSE run --rm api sh -c 'cd packages/api && npx drizzle-kit push --force'

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
