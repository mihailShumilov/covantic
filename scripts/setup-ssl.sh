#!/usr/bin/env bash
set -euo pipefail

# Covantic — SSL Certificate Setup
# Usage: DOMAIN=covantic.xyz bash scripts/setup-ssl.sh

DOMAIN="${DOMAIN:?Set DOMAIN env var, e.g. DOMAIN=covantic.xyz}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"
COMPOSE="docker compose -f docker/docker-compose.prod.yml"

echo "==> Obtaining SSL certificate for ${DOMAIN}..."

# 1. Start with HTTP-only nginx config
cp docker/nginx/conf.d/initial.conf docker/nginx/conf.d/active.conf
sed -i "s/YOUR_DOMAIN.com/${DOMAIN}/g" docker/nginx/conf.d/active.conf

# Remove the full SSL config temporarily
rm -f docker/nginx/conf.d/covantic.conf

# 2. Start nginx + certbot
$COMPOSE up -d nginx

# 3. Request certificate
docker compose -f docker/docker-compose.prod.yml run --rm certbot \
  certbot certonly --webroot -w /var/www/certbot \
  --email "$EMAIL" --agree-tos --no-eff-email \
  -d "$DOMAIN"

# 4. Switch to full SSL config
rm docker/nginx/conf.d/active.conf
cp docker/nginx/conf.d/covantic.conf docker/nginx/conf.d/active.conf
sed -i "s/YOUR_DOMAIN.com/${DOMAIN}/g" docker/nginx/conf.d/active.conf

# 5. Reload nginx
$COMPOSE exec nginx nginx -s reload

echo "==> SSL configured for ${DOMAIN}"
