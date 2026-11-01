# Covantic

**The coverage primitive for autonomous agents.**

Covantic is the first parametric insurance protocol for AI agents on Solana. Agents purchase coverage before DeFi operations. When a covered event occurs — exploit, oracle manipulation, critical error — the protocol proves the loss on-chain and pays out in USDC after a short lock period. No paperwork. A claim the program cannot prove goes to a reviewer, never to an automatic rejection.

**Live on Solana devnet:** [covantic.org](https://covantic.org) · [demo](https://covantic.org/demo) · [how it works](https://covantic.org/tech) · [security](https://covantic.org/security)

## Status

- **Network** — Solana devnet with test USDC, not mainnet. Program: [`HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL`](https://explorer.solana.com/address/HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL?cluster=devnet).
- **Settlement** — every payout goes through an instruction that re-derives its bound from state the program reads; there is no unverified settlement path. Exploit, governance and agent-error claims settle autonomously. Oracle-manipulation claims go to a reviewer until a Pyth Hermes credential is configured; the proof instruction itself is deployed and tested. As of the [2026-09-04 results](docs/M1_RESULTS.md).
- **Proven end to end** — on devnet, policy #56 paid [500 USDC](https://explorer.solana.com/tx/3BSF8bTtk8jjtFRZvwKvHv8UjPdo4UuYnGFzCdjp8dyNS9C4mp5ZM2kbYKnKerUeL91nSpcf64rsiY31YXWQKZzw?cluster=devnet) against a premium of 0.29 USDC, 47.4 seconds after the breach, with nobody approving it ([`docs/DEMO.md`](docs/DEMO.md)).
- **Security** — [V12](https://v12.sh/) audit of `11b28f6`: 26 findings, 25 closed in code and 1 acknowledged, verified at tag [`audit-2026-09-15`](https://github.com/mihailShumilov/covantic/tree/audit-2026-09-15) ([report](docs/audit/VERIFICATION-2026-09-15-31a5d49.md)).

## How It Works

1. **Assess** — AI Risk Scorer weighs 15 on-chain signals from the agent's last 100 transactions to assign a tier (LOW / MEDIUM / HIGH / EXTREME-uninsurable)
2. **Attest** — The oracle signs an on-chain `RiskAttestation` PDA for the agent; `create_policy` reads the tier from it so buyers cannot self-select a cheaper tier
3. **Insure** — Holder buys a policy on-chain; premium auto-calculated from the attested tier. The policy is provable from the moment of purchase: `create_policy` writes the balance checkpoint and the operating envelope
4. **Monitor** — a sweep over every insured agent (every 2 minutes, over the RPC pool) plus Helius webhooks detect anomalies; the claim-keeper drives submit + payout
5. **Payout** — Trigger fires → `oracle_submit_claim` → lock period → the trigger's proof instruction (`verify_and_payout_v2`, `_exploit`, `_governance` or `_agent_error`) re-derives the bound on chain → USDC transferred to holder's ATA

## Quick Start

Requires Node.js 24+, pnpm 9+, Docker, the Solana CLI and `anchor-cli` 1.0.2 installed from crates.io
(`cargo install anchor-cli --version 1.0.2 --locked`). The npm distribution of `anchor-cli` exits 0 on
failure, so do not use it.

```bash
git clone https://github.com/mihailShumilov/covantic.git
cd covantic
bash scripts/setup-local.sh        # install, .env, oracle keypair, docker up, db migrate, anchor build
                                   # then fill in the API keys and secrets in .env
pnpm init:devnet                   # anchor build + deploy, create devnet USDC, init config/vault
pnpm fund:phantom <WALLET> 1000    # mint test USDC to your browser wallet
pnpm dev                           # api:4099 + web:3099 + workers + agent fleet
```

`pnpm dev` expects PostgreSQL (5499) and Redis (6399) to be running: `setup-local.sh` starts them, and
`pnpm docker:up` starts them afterwards. The API process runs the background workers (expiry-crank,
solvency-checker, analytics-aggregator, policy-indexer, claim-keeper, oracle-watcher, exploit-watcher).

For the autonomous payout on devnet, see [`docs/DEMO.md`](docs/DEMO.md). For a full walkthrough
including buying policies, simulating incidents, and the agent fleet, see
[`docs/MANUAL_DEMO.md`](docs/MANUAL_DEMO.md).

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
| Critical Agent Error   | Movement outside the policy's operating envelope                | 6 hours     |
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

Premium = coverage × annual rate × duration ÷ 365 days, scaled by a
solvency-based multiplier (minimum 0.001 USDC). Each premium splits 70% to
stakers, 20% to the reserve and 10% to the protocol treasury; unstaking has a
48-hour cooldown. A plain-language walkthrough of scoring, detection, payout and staking is at
[covantic.org/tech](https://covantic.org/tech).

## Development

```bash
pnpm dev                 # Start api, workers, fleet and web (run docker:up first)
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
pnpm mandate:declare --policy <id> --max-single <usdc>   # Widen the agent's operating envelope
pnpm demo:arm|status                 # Keep demo policies ready and list them
pnpm demo:autonomous --policy <id> --agent <name> --amount <usdc>   # Run the autonomous payout
pnpm --filter api claim:replay <id>  # Re-derive a stored claim verdict from its evidence
```

## Related Docs

- [`docs/DEMO.md`](docs/DEMO.md) — the autonomous settlement demo, one command per step
- [`docs/MANUAL_DEMO.md`](docs/MANUAL_DEMO.md) — end-to-end demo & QA walkthrough
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — component + data-flow overview
- [`docs/API.md`](docs/API.md) — HTTP + WebSocket reference
- [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md) — local setup & troubleshooting
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production deploy playbook
- [`docs/M1_RESULTS.md`](docs/M1_RESULTS.md) — measured detection results: corpora, mainnet backtest, coverage limits
- [`docs/audit/`](docs/audit/README.md) — audit reports, remediation record and verification
- [`docs/EXPLOIT_DETECTION.md`](docs/EXPLOIT_DETECTION.md) · [`docs/ORACLE_MANIPULATION_DETECTION.md`](docs/ORACLE_MANIPULATION_DETECTION.md) · [`docs/GOVERNANCE_ATTACK_DETECTION.md`](docs/GOVERNANCE_ATTACK_DETECTION.md) · [`docs/AGENT_ERROR_DETECTION.md`](docs/AGENT_ERROR_DETECTION.md) — one per trigger: detection, verification, settlement

## License

MIT
