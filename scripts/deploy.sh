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

echo "==> Applying database migrations..."
# `push --force` previously ran here: it drops/recreates tables whenever the
# schema diverges, which can silently delete production data. Prefer real
# migration files (drizzle-kit generate) applied with migrate(). If the
# migrations folder is missing/empty, the API will log "no migrations
# folder found" and start anyway; generate locally and commit the SQL.
$COMPOSE run --rm api sh -c 'cd packages/api && npx drizzle-kit migrate'

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
