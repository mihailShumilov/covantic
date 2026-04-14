# Covantic — Manual Demo & QA Guide

End-to-end walkthrough for the Covantic AI Agent Insurance Protocol on Solana devnet.

Covers:

- Connecting your own browser wallet (Phantom / Solflare).
- Running a risk assessment on any devnet address.
- Buying an insurance policy on-chain.
- Inspecting your policies and their on-chain transactions.
- Triggering an incident (synthetic or real webhook) and watching the
  **fully automated** claim pipeline produce real on-chain signatures.
- Reading the oracle's decision on `/claims`.

Once the system is set up, the "simulate incident → real USDC payout in your
wallet" path requires no CLI scripts, just the UI.

---

## 0. Prerequisites

### Software

- Node.js 22+, pnpm 9+, Docker Desktop
- Solana CLI + Anchor 0.30.x (only needed if you redeploy the program)
- Phantom or Solflare browser extension set to **Devnet**

### First-time setup

From the repo root:

```bash
pnpm install
bash scripts/setup-local.sh     # docker up, .env from template, oracle keypair, db migrate
pnpm init:devnet                # anchor build + deploy, create devnet USDC mint, initialize config/vault
pnpm fund:phantom <YOUR_WALLET> 1000   # mint 1000 test-USDC to your browser wallet
pnpm dev                        # api:4099 + web:3099 + workers
```

`init:devnet` is idempotent — re-running it just confirms the program is
deployed and the config PDA already exists.

### Required env vars (`.env`, auto-populated by `setup-local.sh` + `init:devnet`)

- `SOLANA_RPC_URL`, `SOLANA_NETWORK=devnet`
- `PROGRAM_ID` (written by `init:devnet`)
- `USDC_MINT` (written by `init:devnet` on first run)
- `ORACLE_KEYPAIR_PATH=./keys/oracle-keypair.json` (the keeper signs oracle_submit_claim + verify_and_payout with this)
- `HELIUS_API_KEY`, `HELIUS_WEBHOOK_SECRET`
- `DATABASE_URL`, `REDIS_URL`, `PORT=4099`
- `NEXT_PUBLIC_*` mirrors for the browser

### Wallet prep

1. Open Phantom → switch to **Devnet**.
2. Copy your wallet address.
3. Airdrop SOL for gas:
   ```bash
   solana airdrop 2 <YOUR_WALLET> --url devnet
   ```
4. Mint test USDC:
   ```bash
   pnpm fund:phantom <YOUR_WALLET> 1000
   ```

You should now have devnet SOL **and** devnet test-USDC at the configured
`USDC_MINT`. Mainnet USDC will not work.

Open:
- Web: http://localhost:3099
- API health: http://localhost:4099/api/health
- Explorer: https://explorer.solana.com/?cluster=devnet

---

## 1. Landing page

Go to http://localhost:3099. Sanity-check:

- Hero renders, stats cards are numeric (likely zero on a fresh DB).
- "Get Risk Score" → `/dashboard`.
- "Explore Protocol" → `/protocol`.
- "Run Demo" on the landing page is pure frontend animation — it does not
  touch the API. Use `/demo` for the real pipeline (section 6).

---

## 2. Connect your wallet

1. Click the wallet button in the header (top right).
2. Pick Phantom or Solflare; approve the connection prompt.
3. Header now shows your truncated address.

Devnet is hard-wired; if your wallet is on Mainnet every on-chain call will
fail. Switch to Devnet in the Phantom network selector.

---

## 3. Risk assessment

1. `/dashboard` → **Risk Assessment** card.
2. Paste any devnet address (your own wallet works). Click **Assess Risk**.
3. The pipeline animates while `GET /api/risk/:agent` runs against Helius.
4. The URL silently updates to `/assessment/<uuid>` — a shareable report with
   the risk score, tier, factors, and insurability verdict.

Edge cases worth poking:

| Input | Expected |
| --- | --- |
| Fresh keypair (no history) | LOW/MEDIUM tier, low confidence |
| An active DeFi wallet | Populated factors, usable score |
| Invalid base58 | Inline error, no call made |

---

## 4. Buy an insurance policy

Real on-chain transaction — Phantom prompts for signature.

1. `/dashboard` → **Buy Policy** (top-right).
2. Fill the form:
   - Coverage (USDC): e.g. `50`
   - Duration (hours): e.g. `12`
   - Risk Tier: LOW / MEDIUM / HIGH
   - Agent Wallet Address: **the address you want to insure.** This can be:
     - Your own connected wallet (insuring yourself)
     - A second wallet you control
     - The built-in RiskyBot demo agent `3kTzqDN8uEZwFEhQKvPXDvMkZxvPcFpHgEL9mJQfYWxC`
3. Premium auto-calculates via `POST /api/policies/quote` (debounced 400ms).
4. Confirm → Phantom signs `createPolicy`.
5. Success toast shows a link to the transaction on the explorer.

The **Your Policies** card below refreshes and lists the new policy with
state `ACTIVE`. The list reads directly from chain, so it's always in sync.

Edge cases:

- Wallet without USDC → ATA error. Re-fund via `pnpm fund:phantom`.
- Wallet without SOL → insufficient fees. Airdrop SOL.
- Agent assessed `EXTREME` → quote endpoint returns 400; Buy button refuses.
- Coverage/duration outside limits → form validation fails.

---

## 5. See your on-chain transactions

Two equivalent views of the same data:

### Dashboard

`/dashboard` → **Your Policies** reads on-chain via
`program.account.insurancePolicy.all()`. Each row shows id, state badge,
tier, coverage, premium, expiry. After a claim pays out, it also surfaces
**Paid out: $X USDC**.

### API (indexed)

The policy indexer worker mirrors chain state into Postgres every 60s, so:

```bash
curl 'http://localhost:4099/api/policies?holder=<YOUR_WALLET>'
```

returns the same policies with DB metadata. Useful for scripts and assertions.

### Explorer

Click any tx signature link (from the Buy toast or `/claims`) for the full
instruction breakdown at `https://explorer.solana.com/tx/<sig>?cluster=devnet`.

---

## 6. Simulate an incident

This is the path that was purely animated before — now it produces real
on-chain claims and payouts.

### 6a. Demo agent (one-click, for screen recording)

The `/demo` page hard-codes the RiskyBot agent address. If you purchased a
policy against that address in step 4, the flow is:

1. Open `/claims` in a second tab so you can watch the feed.
2. Go to `/demo`.
3. Click any of: **Simulate Exploit**, **Simulate Oracle Manipulation**,
   **Simulate Agent Error**, **Simulate Governance Attack**.
4. The front-end pipeline animates, but behind the scenes the claim-keeper:
   - Writes a `claims` row, status `pending`.
   - Runs the synthetic verifier (simulated events bypass the Helius path).
   - Calls **`oracle_submit_claim`** signed by the oracle keypair →
     on-chain submit tx.
   - After the trigger's lock period (`exploit=0s`, `oracle=1h`, `error=6h`,
     `gov=2h`), calls **`verify_and_payout`** → on-chain USDC transfer
     to the holder ATA.
5. `/claims` shows the row moving `pending → verifying → approved → paid`
   in real time (WebSocket `claims:feed`). Each step broadcasts immediately;
   no refresh required.
6. `/dashboard` now shows the policy state `CLAIM_PAID` with the payout
   amount, and your Phantom USDC balance increased.

### 6b. Your own agent (end-to-end against any policy)

If your policy's agent is **not** the RiskyBot address, the UI button won't
match it. Fire the alert directly at the API:

```bash
curl -X POST http://localhost:4099/api/demo/simulate-exploit \
  -H 'content-type: application/json' \
  -d '{"agentAddress":"<YOUR_AGENT_WALLET>","type":"exploit"}'
```

Same synthetic verifier, same on-chain submit + payout. Watch `/claims`.

Supported `type` values: `exploit`, `oracle_deviation`, `agent_error`,
`governance_attack`.

### 6c. Real Helius webhook (production path)

`POST /api/monitoring/webhook` is the path production uses. Sign the body
with HMAC-SHA256 against `HELIUS_WEBHOOK_SECRET` and send a Helius enriched
transaction. The transaction-monitor detects large-transfer / failed_tx
anomalies, publishes to `monitoring:alerts`, and the keeper handles the
rest. See `packages/api/src/services/transaction-monitor.ts` for thresholds.

---

## 7. Watch the automated decision

### /claims (live feed)

`/claims` subscribes to the `claims:feed` WebSocket channel. Each row shows:

- Policy id
- Status badge (`pending` → `verifying` → `approved` → `paid`; or
  `rejected` / `failed`)
- Trigger label
- Payout amount once approved
- **Submit tx ↗** and **Payout tx ↗** links to the explorer

Click a row to focus the **Verification Pipeline** on the right — its five
steps reflect the selected claim's actual status (no animation, no fudging).

### /dashboard

After a claim pays out, the originating policy on `/dashboard` shows:

- State badge: `CLAIM_PAID`
- Payout amount in USDC
- Your Phantom USDC balance reflects the new coverage transfer.

Confirm the on-chain side: open the policy's PDA in the explorer; the tail
of its tx list includes `oracle_submit_claim` and `verify_and_payout` (from
the oracle authority), and an SPL token transfer of the payout amount.

---

## 8. Staking / protocol (for completeness)

Stakers are what the keeper can pay out against. Without staked USDC the
pipeline will reach `approved` and then fail at payout with
`InsufficientVaultBalance`.

- `/staking`: stake USDC, request + execute unstake (48 h cooldown),
  claim rewards.
- `/protocol`: top-level metrics — TVP, active policies, premiums collected,
  claims paid, solvency, and the 70/20/10 premium split chart.

---

## 9. Full happy-path smoke test

Run through in order; tick each item.

- [ ] `pnpm dev` starts without errors; `/api/health` returns 200.
- [ ] `/` landing renders; stats are numeric.
- [ ] Phantom connects on Devnet; wallet balance ≥ 1 SOL, ≥ 10 test-USDC.
- [ ] `/staking` → stake 25 USDC successfully (seeds the payout vault).
- [ ] `/dashboard` → **Assess Risk** on any address → `/assessment/<id>` renders.
- [ ] `/dashboard` → **Buy Policy** 50 USDC / 12h / MEDIUM / agent = your test wallet.
- [ ] New policy shows `ACTIVE` in **Your Policies**.
- [ ] `GET /api/policies?holder=<WALLET>` returns that policy (indexer worked).
- [ ] Fire simulate-exploit for that agent (UI if RiskyBot, else curl).
- [ ] `/claims` shows the claim; status reaches `paid`.
- [ ] Payout and submit tx links open real explorer pages on devnet.
- [ ] Phantom USDC balance increased by the payout amount.
- [ ] `/dashboard` policy now `CLAIM_PAID` with the payout surface visible.
- [ ] `/protocol` counters — Claims Paid / Total Premiums — incremented.

Automate the simulate-to-paid half of this with:

```bash
pnpm exec tsx scripts/smoke-auto-claim.ts
```

It picks the first `ACTIVE` indexed policy, fires the alert, and asserts
paid-state with real on-chain signatures.

---

## 10. Tear-down / reset

```bash
pnpm docker:down                 # stop postgres + redis
docker volume prune              # DESTRUCTIVE: wipes DB state
pnpm docker:up                   # bring them back empty
pnpm --filter api run db:push    # reapply schema
```

On-chain state stays on devnet and is cheap to leave. Redeploy only if you
change the Rust source:

```bash
pnpm init:devnet                 # rebuild + upgrade program in place
```

---

## Appendix — key surfaces

| Concern | File / Endpoint |
| --- | --- |
| Landing | `packages/web/src/app/page.tsx` |
| Dashboard (risk + policies + buy + payout surface) | `packages/web/src/app/dashboard/page.tsx` |
| Assessment detail | `packages/web/src/app/assessment/[id]/page.tsx` |
| Claims live feed | `packages/web/src/app/claims/page.tsx` + `hooks/useClaimsFeed.ts` |
| Demo (simulate incident) | `packages/web/src/app/demo/page.tsx` |
| Staking / Protocol | `packages/web/src/app/staking/page.tsx`, `protocol/page.tsx` |
| `POST /api/policies/quote`, `GET /api/policies` | `packages/api/src/routes/policies.ts` |
| `GET /api/claims` | `packages/api/src/routes/claims.ts` |
| `POST /api/demo/simulate-exploit` | `packages/api/src/routes/monitoring.ts` |
| `POST /api/monitoring/webhook` | `packages/api/src/routes/monitoring.ts` |
| Policy indexer | `packages/api/src/workers/policy-indexer.ts` |
| Claim-keeper (auto-claim pipeline) | `packages/api/src/workers/claim-keeper.ts` |
| `oracle_submit_claim` instruction | `packages/anchor/programs/covantic/src/instructions/oracle_submit_claim.rs` |
| `verify_and_payout` instruction | `packages/anchor/programs/covantic/src/instructions/verify_and_payout.rs` |
| WebSocket `/ws` (`claims:feed`, `vault:stats`, `monitoring:alerts`) | `packages/api/src/index.ts`, `services/notification-service.ts` |
