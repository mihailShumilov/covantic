#!/bin/bash
# Full local development environment setup for AgentGuard
# Usage: bash scripts/setup-local.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}  AgentGuard — Local Development Setup   ${NC}"
echo -e "${BLUE}=========================================${NC}"

# 1. Check dependencies
echo -e "\n${YELLOW}[1/8] Checking dependencies...${NC}"
command -v node >/dev/null 2>&1 || { echo -e "${RED}Node.js not found. Install v22+${NC}"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo -e "${RED}pnpm not found. Run: npm i -g pnpm@9${NC}"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo -e "${RED}Docker not found.${NC}"; exit 1; }
echo -e "${GREEN}All dependencies found${NC}"

# 2. Install npm packages
echo -e "\n${YELLOW}[2/8] Installing npm packages...${NC}"
pnpm install
echo -e "${GREEN}Packages installed${NC}"

# 3. Copy .env
echo -e "\n${YELLOW}[3/8] Setting up environment...${NC}"
if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${YELLOW}Created .env from template. Edit it with your API keys!${NC}"
else
  echo -e "${GREEN}.env already exists${NC}"
fi

# Load .env so subsequent steps can use the values
set -a
source .env
set +a

# 4. Generate Solana keypairs
echo -e "\n${YELLOW}[4/8] Generating Solana keypairs...${NC}"
mkdir -p keys
if [ ! -f keys/oracle-keypair.json ]; then
  if command -v solana-keygen >/dev/null 2>&1; then
    solana-keygen new --outfile keys/oracle-keypair.json --no-bip39-passphrase --force
    echo -e "${GREEN}Oracle keypair generated${NC}"
  else
    echo -e "${YELLOW}solana-keygen not found. Skipping keypair generation.${NC}"
  fi
fi

# 5. Start Docker services (PostgreSQL + Redis)
echo -e "\n${YELLOW}[5/8] Starting Docker services...${NC}"
docker compose -f docker/docker-compose.yml up -d postgres redis
echo "Waiting for services to be healthy..."
sleep 5
echo -e "${GREEN}PostgreSQL and Redis running${NC}"

# 6. Build shared package
echo -e "\n${YELLOW}[6/8] Building shared package...${NC}"
pnpm --filter shared build
echo -e "${GREEN}Shared package built${NC}"

# 7. Run migrations
echo -e "\n${YELLOW}[7/8] Running database migrations...${NC}"
cd packages/api && npx drizzle-kit push --force 2>/dev/null && cd ../.. || { cd ../.. 2>/dev/null; echo -e "${YELLOW}Migrations skipped (run manually after API build)${NC}"; }
echo -e "${GREEN}Migrations step complete${NC}"

# 8. Build Anchor program (if available)
echo -e "\n${YELLOW}[8/8] Building Anchor program...${NC}"
if command -v anchor >/dev/null 2>&1; then
  if command -v cargo-build-sbf >/dev/null 2>&1 || command -v solana >/dev/null 2>&1; then
    cd packages/anchor
    anchor build --no-idl && echo -e "${GREEN}Anchor program built${NC}" || echo -e "${YELLOW}Anchor build failed. Check Solana CLI and Anchor versions.${NC}"
    cd ../..
  else
    echo -e "${YELLOW}Solana CLI not found (cargo-build-sbf required). Install: sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\"${NC}"
  fi
else
  echo -e "${YELLOW}Anchor CLI not found. Install: cargo install --git https://github.com/coral-xyz/anchor avm && avm install 0.30.1 && avm use 0.30.1${NC}"
fi

echo -e "\n${GREEN}=========================================${NC}"
echo -e "${GREEN}  Setup Complete!                        ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e "\nNext steps:"
echo -e "  1. Add your HELIUS_API_KEY to .env"
echo -e "  2. Run: ${YELLOW}pnpm dev${NC} — starts all services"
echo -e "  3. Open: ${BLUE}http://localhost:3099${NC}"
