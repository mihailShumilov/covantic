#!/bin/sh
set -eu

# Covantic — SSL Certificate Setup
# Usage: DOMAIN=covantic.org sh scripts/setup-ssl.sh

DOMAIN="${DOMAIN:?Set DOMAIN env var, e.g. DOMAIN=covantic.org}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"
COMPOSE="docker compose -f docker/docker-compose.prod.yml --env-file .env"
CONF_DIR="docker/nginx/conf.d"

echo "==> Obtaining SSL certificate for ${DOMAIN}..."

# 1. Start with HTTP-only nginx config for certbot challenge
cp "${CONF_DIR}/http.conf.template" "${CONF_DIR}/active.conf"
sed -i "s/YOUR_DOMAIN.com/${DOMAIN}/g" "${CONF_DIR}/active.conf"

# 2. Start nginx (HTTP only)
$COMPOSE up -d nginx

# 3. Request certificate
$COMPOSE run --rm certbot \
  certbot certonly --webroot -w /var/www/certbot \
  --email "$EMAIL" --agree-tos --no-eff-email \
  -d "$DOMAIN"

# 4. Switch to full SSL config
cp "${CONF_DIR}/ssl.conf.template" "${CONF_DIR}/active.conf"
sed -i "s/YOUR_DOMAIN.com/${DOMAIN}/g" "${CONF_DIR}/active.conf"

# 5. Reload nginx with SSL
$COMPOSE exec nginx nginx -s reload

echo "==> SSL configured for ${DOMAIN}"
