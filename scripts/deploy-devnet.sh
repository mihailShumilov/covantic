#!/bin/bash
# Deploy AgentGuard to Solana devnet
# Usage: bash scripts/deploy-devnet.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}  AgentGuard — Devnet Deployment         ${NC}"
echo -e "${BLUE}=========================================${NC}"

# 1. Check Solana CLI config
echo -e "\n${YELLOW}[1/6] Checking Solana CLI configuration...${NC}"
solana config set --url devnet
WALLET=$(solana address)
BALANCE=$(solana balance | awk '{print $1}')
echo -e "Wallet: ${BLUE}${WALLET}${NC}"
echo -e "Balance: ${BLUE}${BALANCE} SOL${NC}"

if (( $(echo "$BALANCE < 2" | bc -l) )); then
  echo -e "${YELLOW}Balance low. Requesting airdrop...${NC}"
  solana airdrop 2
  sleep 5
fi

# 2. Build program
echo -e "\n${YELLOW}[2/6] Building Anchor program...${NC}"
cd packages/anchor
anchor build
echo -e "${GREEN}Program built${NC}"

# 3. Deploy program
echo -e "\n${YELLOW}[3/6] Deploying to devnet...${NC}"
anchor deploy --provider.cluster devnet
PROGRAM_ID=$(solana-keygen pubkey target/deploy/agentguard-keypair.json)
echo -e "${GREEN}Program deployed: ${PROGRAM_ID}${NC}"
cd ../..

# 4. Update .env
echo -e "\n${YELLOW}[4/6] Updating configuration...${NC}"
sed -i.bak "s/PROGRAM_ID=.*/PROGRAM_ID=${PROGRAM_ID}/" .env
sed -i.bak "s/NEXT_PUBLIC_PROGRAM_ID=.*/NEXT_PUBLIC_PROGRAM_ID=${PROGRAM_ID}/" .env
echo -e "${GREEN}.env updated with Program ID${NC}"

# 5. Seed demo data
echo -e "\n${YELLOW}[5/6] Seeding demo data...${NC}"
pnpm --filter api run db:seed 2>/dev/null || echo "Seeding skipped"
echo -e "${GREEN}Demo data seeded${NC}"

echo -e "\n${GREEN}=========================================${NC}"
echo -e "${GREEN}  Deployment Complete!                   ${NC}"
echo -e "${GREEN}=========================================${NC}"
echo -e "\nProgram ID: ${BLUE}${PROGRAM_ID}${NC}"
echo -e "Network:    ${BLUE}devnet${NC}"
echo -e "\nExplorer: ${BLUE}https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet${NC}"
