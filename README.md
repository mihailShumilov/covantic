# Covantic

**The coverage primitive for autonomous agents.**

Covantic is the first parametric insurance protocol for AI agents on Solana. Agents purchase coverage before DeFi operations. When a covered event occurs — exploit, oracle manipulation, critical error — the protocol proves the loss on-chain and pays out in USDC after a short lock period. No paperwork. A claim the program cannot prove goes to a reviewer, never to an automatic rejection.

> Built for [Colosseum Frontier Hackathon](https://colosseum.org) — April–May 2026

## How It Works

1. **Assess** — AI Risk Scorer weighs 15 on-chain signals from the agent's last 100 transactions to assign a tier (LOW / MEDIUM / HIGH / EXTREME-uninsurable)
2. **Attest** — The oracle signs an on-chain `RiskAttestation` PDA for the agent; `create_policy` reads the tier from it so buyers cannot self-select a cheaper tier
3. **Insure** — Holder buys a policy on-chain; premium auto-calculated from the attested tier
4. **Monitor** — a sweep over every insured agent (every 2 minutes, over the RPC pool) plus Helius webhooks detect anomalies; the claim-keeper drives submit + payout
5. **Payout** — Trigger fires → `oracle_submit_claim` → lock period → the trigger's proof instruction (`verify_and_payout_v2`, `_exploit`, `_governance` or `_agent_error`) re-derives the bound on chain → USDC transferred to holder's ATA

## Quick Start

```bash
git clone https://github.com/mihailShumilov/ai-agent-insurance.git
cd ai-agent-insurance
bash scripts/setup-local.sh        # docker up, .env, oracle keypair, db migrate
pnpm init:devnet                   # anchor build + deploy, create devnet USDC, init config/vault
pnpm fund:phantom <WALLET> 1000    # mint test USDC to your browser wallet
pnpm dev                           # docker + api:4099 + web:3099 + workers
```

This starts PostgreSQL (5499), Redis (6399), Backend API (4099), Frontend (3099), and background workers
(expiry-crank, solvency-checker, analytics-aggregator, policy-indexer, claim-keeper).

For a full end-to-end walkthrough including buying policies, simulating incidents, and the autonomous
agent fleet, see [`docs/MANUAL_DEMO.md`](docs/MANUAL_DEMO.md).

> The Solana Agent Kit plugin lives in a separate repo: [`covantic-solana-sdk`](https://github.com/mihailShumilov/covantic-solana-sdk).

## Architecture

```
packages/
  anchor/   — Solana program (Rust, Anchor 1.0.2)
  api/      — Backend (Fastify 5, Drizzle ORM, BullMQ)
  web/      — Frontend (Next.js 16, React 19)
  shared/   — Cross-package types, constants, utilities
```

## Tech Stack

Solana (Anchor 1.0.2) · Next.js 16 · Fastify 5 · PostgreSQL 18 · Helius · Pyth · Solana Agent Kit

## Coverage Triggers

| Trigger                | Condition                                                       | Lock Period |
| ---------------------- | --------------------------------------------------------------- | ----------- |
| Smart Contract Exploit | Unauthorized movement; balance drop ≥50% against the checkpoint | 1 hour      |
| Oracle Manipulation    | Fill priced ≥0.5% (50 bps) away from the Pyth price             | 1 hour      |
| Critical Agent Error   | Movement outside the holder's declared mandate                  | 6 hours     |
| Governance Attack      | Control of the agent leaves the holder's declared authority set | 2 hours     |

The agent-error trigger covers a loss the agent caused with its _own_
authority — which is exactly the case no forensic evidence can separate from a
deliberate decision, because the difference lives in the holder's intent. So
the envelope is fixed in advance. At purchase it is derived from the agent's
own outflow history rather than chosen by the buyer: the single-transfer cap is
5 × the 95th-percentile outflow (at least 5 observations are needed) and the
window cap is 3 × that over an hour. The oracle commits to its hash in the
attestation, `create_policy` writes it, and it is usable immediately. The
holder can later widen it with `pnpm mandate:declare`; a re-declaration matures
an hour later. A claim is proven by comparing the movement against the
envelope, and the vault pays the whole amount by which the movement _exceeded_
it (capped at coverage), so the cap acts as a deductible. A loss inside the
envelope is not covered.

The governance trigger covers three shapes: an account seized via
`SetAuthority`, an account frozen (the balance never moves and the agent can
no longer use it), and an allowance granted to a stranger and drawn. The
holder declares who may legitimately control the agent — `pnpm gov:declare` —
and the declaration matures an hour later; a claim is proven by comparing it
against what the program reads on the account. A loss whose conjunction with
the takeover falls outside 30 minutes is not denied, it goes to a reviewer.

## Risk Tiers

| Tier    | Annual Premium | Score Range |
| ------- | -------------- | ----------- |
| LOW     | 1.0%           | 0 — 0.30    |
| MEDIUM  | 2.5%           | 0.30 — 0.60 |
| HIGH    | 5.0%           | 0.60 — 0.85 |
| EXTREME | Declined       | above 0.85  |

Premium = coverage × annual rate × duration ÷ 365 days (minimum 0.001 USDC).
A plain-language walkthrough of scoring, detection, payout and staking is at
[covantic.org/tech](https://covantic.org/tech).

## Development

```bash
pnpm dev                 # Start all (docker + api + web)
pnpm build               # Build all packages
pnpm test                # Run all tests
pnpm test:anchor         # Anchor tests only
pnpm docker:up/down      # Manage Docker services
pnpm init:devnet         # Build + deploy + initialize the Anchor program on devnet
pnpm fund:phantom <addr> [amount]    # Mint devnet test-USDC to a wallet
pnpm webhook:sync        # Register/refresh the Helius webhook for all insured agents
pnpm agent:create|fund|trigger       # Throwaway agent keypair CLI for real on-chain activity
pnpm fleet:bootstrap|start|status    # Autonomous fleet of policy-covered agents
pnpm gov:declare --policy <id>       # Declare the agent's legitimate authority set
pnpm mandate:declare --policy <id> --max-single <usdc>   # Declare the agent's operating envelope
```

## Related Docs

- [`docs/MANUAL_DEMO.md`](docs/MANUAL_DEMO.md) — end-to-end demo & QA walkthrough
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — component + data-flow overview
- [`docs/API.md`](docs/API.md) — HTTP + WebSocket reference
- [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md) — local setup & troubleshooting
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production deploy playbook
- [`docs/M1_RESULTS.md`](docs/M1_RESULTS.md) — measured detection results: corpora, mainnet backtest, coverage limits
- [`docs/EXPLOIT_DETECTION.md`](docs/EXPLOIT_DETECTION.md) · [`docs/ORACLE_MANIPULATION_DETECTION.md`](docs/ORACLE_MANIPULATION_DETECTION.md) · [`docs/GOVERNANCE_ATTACK_DETECTION.md`](docs/GOVERNANCE_ATTACK_DETECTION.md) · [`docs/AGENT_ERROR_DETECTION.md`](docs/AGENT_ERROR_DETECTION.md) — one per trigger: detection, verification, settlement

## License

MIT
