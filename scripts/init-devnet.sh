#!/bin/bash
# Prepare devnet end-to-end: build & deploy the program, mint devnet USDC,
# and run `initialize` so the protocol config and vault exist on-chain.
#
# Idempotent — safe to re-run. Re-deploys only if the program binary changed
# (anchor is responsible for that), recreates the USDC mint only when
# USDC_MINT is unset or placeholder, and skips `initialize` if the config
# PDA is already on-chain.
#
# Usage:
#   bash scripts/init-devnet.sh
#
# Prereqs:
#   - `.env` populated with SOLANA_RPC_URL, PROGRAM_ID, ORACLE_KEYPAIR_PATH,
#     HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET.
#   - Deployer wallet (`solana address`) funded with ~3 SOL on devnet.
#   - Solana CLI and Anchor toolchains installed and on PATH.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}  Covantic — Devnet Initialization       ${NC}"
echo -e "${BLUE}=========================================${NC}"

# --- sanity checks --------------------------------------------------------
command -v solana >/dev/null 2>&1 || { echo -e "${RED}solana CLI not found on PATH.${NC}"; exit 1; }
command -v anchor >/dev/null 2>&1 || { echo -e "${RED}anchor CLI not found on PATH.${NC}"; exit 1; }
command -v pnpm   >/dev/null 2>&1 || { echo -e "${RED}pnpm not found on PATH.${NC}"; exit 1; }

if [ ! -f .env ]; then
  echo -e "${RED}Missing .env at repo root. Run scripts/setup-local.sh first.${NC}"
  exit 1
fi

# Load .env into the current shell so we can read + update PROGRAM_ID / USDC_MINT
set -a
# shellcheck disable=SC1091
source .env
set +a

solana config set --url "${SOLANA_RPC_URL}" >/dev/null

WALLET=$(solana address)
BALANCE=$(solana balance --output json 2>/dev/null | awk -F'[:"]' '/value/ {print $5}' || echo "0")
echo -e "Deployer: ${BLUE}${WALLET}${NC}"
echo -e "Balance:  ${BLUE}${BALANCE} SOL${NC}"

# --- 1. Build --------------------------------------------------------------
echo -e "\n${YELLOW}[1/3] Building Anchor program...${NC}"
(cd packages/anchor && anchor build)
echo -e "${GREEN}Build ok${NC}"

# --- 2. Deploy (upgrade-in-place if PROGRAM_ID already exists on chain) ----
echo -e "\n${YELLOW}[2/3] Deploying program to devnet...${NC}"
(cd packages/anchor && anchor deploy --provider.cluster devnet)
PROGRAM_ID_FROM_KEY=$(solana-keygen pubkey packages/anchor/target/deploy/covantic-keypair.json)
echo -e "${GREEN}Program ready: ${PROGRAM_ID_FROM_KEY}${NC}"

# Rewrite PROGRAM_ID + NEXT_PUBLIC_PROGRAM_ID in .env so the API/web pick up
# the correct ID the next time they boot.
sed -i.bak "s|^PROGRAM_ID=.*|PROGRAM_ID=${PROGRAM_ID_FROM_KEY}|" .env
sed -i.bak "s|^NEXT_PUBLIC_PROGRAM_ID=.*|NEXT_PUBLIC_PROGRAM_ID=${PROGRAM_ID_FROM_KEY}|" .env
rm -f .env.bak

# --- 3. Initialize protocol + ensure USDC mint exists ---------------------
# init-protocol.ts creates a devnet mock-USDC mint if USDC_MINT is unset,
# writes the new mint into .env, then runs `initialize` (or exits 0 if
# already initialized).
echo -e "\n${YELLOW}[3/3] Initializing protocol config + vault...${NC}"
pnpm --filter api exec tsx scripts/init-protocol.ts

# Re-read .env in case init-protocol.ts wrote USDC_MINT
set -a
# shellcheck disable=SC1091
source .env
set +a

echo -e "\n${GREEN}=========================================${NC}"
echo -e "${GREEN}  Devnet initialization complete         ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e "PROGRAM_ID: ${BLUE}${PROGRAM_ID_FROM_KEY}${NC}"
echo -e "USDC_MINT:  ${BLUE}${USDC_MINT:-<unset>}${NC}"
echo -e "\nNext: fund your browser wallet with test USDC:"
echo -e "  ${YELLOW}pnpm fund:phantom <YOUR_WALLET_ADDRESS> [amount=1000]${NC}"
echo -e "Then run ${YELLOW}pnpm dev${NC} and open http://localhost:3099"
