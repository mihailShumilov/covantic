# Architecture

## Overview

Covantic is a parametric insurance protocol for AI agents on Solana. The system consists of five main components:

### 1. Solana Program (Anchor)

On-chain smart contract managing:

- Protocol configuration and vault state
- Insurance policy lifecycle (create, cancel, expire)
- Claim submission and oracle-verified payouts
- USDC staking pool with reward distribution

### 2. Backend API (Fastify)

Off-chain service providing:

- AI risk scoring engine (7-factor weighted model)
- Claim verification oracle (4 trigger types)
- Transaction monitoring via Helius webhooks
- Real-time WebSocket notifications
- Background workers (expiry crank, solvency checker, analytics)

### 3. Frontend (Next.js)

Dashboard application with:

- Agent risk assessment interface
- Policy management (buy, view, cancel)
- Staking pool management
- Real-time claims feed with verification pipeline visualization
- Demo mode for hackathon presentation

### 4. SDK Plugin

Solana Agent Kit integration enabling AI agents to:

- Check risk scores programmatically
- Purchase insurance before DeFi operations
- Submit claims automatically
- Query active policies

### 5. Shared Package

Cross-package types, constants, and utility functions ensuring type safety across the entire stack.

## Data Flow

```
Agent → Risk Score API → Buy Policy (on-chain) → Monitor Agent TXs
                                                         ↓
                                              Anomaly Detected
                                                         ↓
                                              Auto-Submit Claim
                                                         ↓
                                         Oracle Verifies → Payout (on-chain)
```

## Security Model

- **Oracle Authority**: Single designated keypair for claim verification
- **Admin Authority**: Protocol parameter management
- **PDA-based**: All state accounts use deterministic PDAs
- **Solvency Guards**: Automatic policy restrictions at low solvency levels
