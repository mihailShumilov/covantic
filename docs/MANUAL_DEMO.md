# Covantic — Manual Demo & QA Guide

End-to-end manual walkthrough for the Covantic AI Agent Insurance Protocol on Solana devnet.

This guide assumes you want to:

- Use your **own wallet** (Phantom or Solflare on devnet).
- Interact with an **agent address** (your own wallet, a second wallet you control, or the built-in demo agent).
- **Buy an insurance policy** for an agent transaction.
- **Simulate an incident** and watch the claim pipeline.
- Inspect your **on-chain transactions** tied to a policy.
- See the **automated decisions** produced by the oracle / workers.

---

## 0. Prerequisites

### Software

- Node.js 22+, pnpm 9+, Docker Desktop running
- Rust + Solana CLI + Anchor 0.30.1 (only needed if you redeploy the program)
- Browser with **Phantom** or **Solflare** extension, switched to **Devnet**

### Wallet preparation

Before you start the demo, fund your browser wallet on devnet:

1. Open Phantom → switch network to **Devnet**.
2. Copy your wallet address (e.g. `9xPu…abcd`).
3. Airdrop SOL (for gas):
   ```bash
   solana airdrop 2 <YOUR_WALLET> --url devnet
   ```
   Repeat once or twice. 2 SOL is plenty for the demo.
4. Mint devnet test USDC to your wallet. The `USDC_MINT` used by the protocol is defined in the root `.env` file. A helper is provided:
   ```bash
   # mints 1000 test-USDC to <YOUR_WALLET>
   pnpm --filter anchor run mint-usdc -- <YOUR_WALLET> 1000
   ```
   If that script is not available in your checkout, use the `spl-token` CLI:
   ```bash
   spl-token create-account $USDC_MINT --owner <YOUR_WALLET> --url devnet
   spl-token mint $USDC_MINT 1000 -- <YOUR_WALLET_TOKEN_ACCOUNT> --url devnet
   ```

You need two things in Phantom before buying a policy:
- **Devnet SOL** (for transaction fees).
- **Devnet test USDC** at the `USDC_MINT` configured in `.env`. Real mainnet USDC will **not** work.

### Start the stack

From the repo root:

```bash
pnpm install
bash scripts/setup-local.sh          # first time only — writes .env, creates oracle keypair, pushes DB schema
pnpm dev                             # starts docker (postgres:5499, redis:6399) + api:4099 + web:3099
```

Open:

- Web: <http://localhost:3099>
- API: <http://localhost:4099/api/health>
- Solana Explorer (devnet): <https://explorer.solana.com/?cluster=devnet>

> If `/api/health` returns 200 and the web app renders, the environment is ready.

---

## 1. Landing page

1. Navigate to <http://localhost:3099>.
2. You should see the hero "Your agent deserves a safety net" with two CTAs:
   - **Get Risk Score** → `/dashboard`
   - **Explore Protocol** → `/protocol`
3. Scroll through the page. The "Run Demo" button replays the claim-verification animation inline — useful as a sanity check that the frontend is healthy, but it does **not** touch the API.

**Expected:** All stats cards render with numbers (may be zero on a fresh DB). No red errors in the browser console. The header shows a "Select Wallet" button on the right.

---

## 2. Connect your wallet

1. Click the wallet button in the top-right of the header.
2. Choose **Phantom** or **Solflare** from the modal.
3. Approve the connection request in the extension.
4. The header should now show a shortened version of your address.

**Expected:**
- The selected wallet is on **Devnet** (check Phantom's network indicator).
- The web app auto-connects the next time you visit.
- If the wallet is on Mainnet you will be able to connect but every on-chain call will fail — switch to Devnet.

---

## 3. Run a risk assessment on your own wallet

Use this to see how the scoring pipeline classifies an address.

1. Go to <http://localhost:3099/dashboard>.
2. In the **Risk Assessment** card, paste your wallet address (or any devnet address you want to insure).
3. Click **Assess Risk**. The pipeline animation starts.
4. Under the hood the browser calls `GET /api/risk/<agentAddress>` (`packages/api/src/routes/risk.ts`). The `risk-scorer` service pulls the address history via Helius and returns a score + tier.
5. The URL silently updates to `/assessment/<uuid>`. Bookmark or share that link — it renders a standalone report (`packages/web/src/app/assessment/[id]/page.tsx`) with:
   - Numeric score and tier badge (LOW / MEDIUM / HIGH / EXTREME)
   - Annual premium %
   - Confidence %
   - Category breakdown + factor-by-factor explanation
   - Summary and recommendation paragraph

**Cases to check:**

| Case | Input | Expected |
|---|---|---|
| Fresh wallet (no activity) | a new devnet keypair | LOW or MEDIUM tier, low confidence |
| Active wallet | your main devnet wallet | numeric score, several factors populated |
| EXTREME tier | rarely hit organically; force by editing the response for demo purposes | `isInsurable: false` — Buy Policy should reject |
| Invalid address | `notbase58` | 400 from API, inline error in UI |

Leave the assessment ID handy; the buy-policy flow will reuse the same agent address.

---

## 4. Buy an insurance policy

This is the core on-chain flow. You will sign one transaction that calls the Anchor `createPolicy` instruction.

1. Still on `/dashboard`, with wallet connected, click **Buy Policy** (top-right).
2. Fill the form in the modal:
   - **Coverage (USDC):** e.g. `50`
   - **Duration (hours):** e.g. `12`
   - **Risk Tier:** `LOW` / `MEDIUM` / `HIGH` (must match the tier returned by the assessment; mismatch is allowed but represents a deliberate override)
   - **Agent Wallet Address:** the address you want to insure. This can be:
     - Your **own** connected wallet — useful if you want to insure yourself.
     - A second wallet you control — required if you later want to manually submit a "real" anomalous transaction from that agent.
     - The built-in demo agent `3kTzqDN8uEZwFEhQKvPXDvMkZxvPcFpHgEL9mJQfYWxC` — required for the one-click Simulate Incident flow.
3. After ~400ms the form calls `POST /api/policies/quote` and shows the premium.
4. Click **Buy Policy** / **Confirm**.
5. Phantom opens — review and approve. The transaction runs `createPolicy` against the deployed program (`packages/anchor/programs/.../lib.rs`).
6. On success the modal displays `Sent! [View on Explorer →]`. Click the link — it opens `https://explorer.solana.com/tx/<sig>?cluster=devnet` with the on-chain instruction breakdown.
7. Close the modal. The **Your Policies** card now lists the new policy (state `ACTIVE`, coverage, premium, expiry).

**Edge cases to verify:**

- Wallet without USDC → tx fails with an ATA error. Fund and retry.
- Wallet without SOL → Phantom shows "insufficient fees". Airdrop and retry.
- Agent tier `EXTREME` → quote endpoint returns 4xx, Buy button disabled.
- Coverage outside [1, 1_000_000] USDC → form validation error (constants in `@covantic/shared`).
- Duration outside [1h, 30d] → form validation error.
- Reopen the dashboard in a new tab — the policy persists (read directly from chain, not the DB).

---

## 5. See your on-chain transactions for a policy

The dashboard reads policies directly from chain using `program.account.insurancePolicy.all()` filtered by holder. Each policy entry exposes:

- `policyId` (the `#42` badge)
- `pdaAddress` — the policy PDA
- `state`, `triggerType`, `triggerTxSignature`, `payoutAmount`

To inspect the full on-chain history:

1. Copy the policy PDA (hover the badge — the PDA is the underlying React key). Alternatively grab the tx signature from the "Buy Policy" success toast.
2. Open <https://explorer.solana.com/address/<PDA>?cluster=devnet>.
3. The **Transactions** tab lists every instruction that touched the PDA:
   - `createPolicy` — your purchase
   - `submitClaim` / `verifyClaim` — oracle activity (appears after an incident is detected)
   - `executePayout` — the USDC transfer back to you
4. Cross-reference with the API: `GET http://localhost:4099/api/policies?holder=<YOUR_WALLET>` returns the same list with DB-side metadata (creation time, quote used, etc.).

---

## 6. Simulate an incident

There are **two** ways to trigger a claim pipeline depending on which agent you insured.

### 6a. Demo agent (one-click, recommended for screen recording)

If the policy you bought in step 4 was written against `3kTzqDN8uEZwFEhQKvPXDvMkZxvPcFpHgEL9mJQfYWxC`:

1. Navigate to <http://localhost:3099/demo>.
2. You will see the **RiskyBot** card and four buttons:
   - **Simulate Exploit** → trigger type `exploit`
   - **Simulate Oracle Manipulation** → `oracle_deviation`
   - **Simulate Agent Error** → `agent_error`
   - **Simulate Governance Attack** → `governance_attack`
3. Click one. The frontend calls `POST /api/demo/simulate-exploit` (`packages/api/src/routes/monitoring.ts:79`) with:
   ```json
   { "agentAddress": "3kTzqDN8...YWxC", "type": "exploit" }
   ```
4. The Event Log on the left fills in:
   - `Simulating Exploit Detection...`
   - `Anomaly detected by monitoring system`
   - `Auto-submitting insurance claim...`
   - `Verification pipeline started`
   - eventually `Payout completed! USDC transferred to agent owner.`
5. The right column animates the 5-step pipeline (Policy Validation → Trigger Detection → Loss Calculation → Oracle Confirmation → Payout Execution).

> The `/api/demo/simulate-exploit` endpoint is disabled in production (`NODE_ENV === 'production'` returns 404).

### 6b. Your own agent address (end-to-end automated flow)

To see the **real** auto-claim flow produce a decision for *your* policy, the agent has to generate a monitored anomaly. The demo button above hard-codes the RiskyBot address, so you cannot use it for an arbitrary agent. Use one of:

**Option A — call the demo endpoint with your agent:**

```bash
curl -X POST http://localhost:4099/api/demo/simulate-exploit \
  -H "content-type: application/json" \
  -d '{"agentAddress":"<YOUR_AGENT_WALLET>","type":"oracle_deviation"}'
```

This writes a `critical` monitoringEvents row and publishes to the `monitoring:alerts` Redis channel, exactly like the UI button. The transaction-monitor and claim-oracle pick it up and match it against any `ACTIVE` policy where `agentAddress == YOUR_AGENT_WALLET`.

**Option B — feed the Helius webhook manually:**

`POST /api/monitoring/webhook` (`monitoring.ts:58`) is the real production entry point. Sign the body with `HELIUS_WEBHOOK_SECRET` (HMAC-SHA256) and post a Helius-shaped enriched-transaction array. Useful if you want to exercise the real signature-verification path.

**Cases to verify:**

- Trigger an `exploit` for an agent with an ACTIVE policy → claim appears on `/claims`, transitions `pending → verifying → approved → paid`.
- Trigger for an agent with no matching policy → event is stored, no claim created.
- Trigger for an EXPIRED policy → claim created and rejected (status `rejected`).
- Trigger twice for the same policy → second attempt is rejected (policy `state` moves out of `ACTIVE` after the first claim).

---

## 7. Watch the automated decision

Every trigger runs through `claim-oracle` (`packages/api/src/services/claim-oracle.ts`) and the background workers (`packages/api/src/workers/`). The decision surfaces in two places.

### 7a. Claims feed UI

1. Open <http://localhost:3099/claims> in a second tab before you fire the trigger.
2. After the simulation, the list (`GET /api/claims`) shows a new row: `Policy #<id>`, with a status badge that moves through:
   - `pending` (yellow) — claim recorded
   - `verifying` (blue) — oracle calling the verifier for that trigger type
   - `approved` (green) — verifier passed; payout tx built
   - `paid` (green) — USDC moved from vault to holder ATA
   - `rejected` (red) — verifier failed (bad proof, duplicate, etc.)
3. Click the row. The right column shows the static pipeline; the left row shows the payout amount once paid.

> The current UI polls on mount. Refresh the page (⌘R) if you don't see the status move. The WebSocket feed on `ws://localhost:4099/ws` also publishes to the `claims:feed` channel if you want to tail live updates with `wscat`.

### 7b. Dashboard — policy state

Go back to `/dashboard`. The policy you bought now shows:

- **State:** `CLAIMED` or `EXPIRED` (depending on which verifier ran)
- **Payout amount:** non-zero if approved
- A trigger tx signature is set on the `InsurancePolicy` account — visible via `program.account.insurancePolicy.fetch(PDA)` or the explorer.

Confirm the payout on-chain:

- Open the policy PDA in the explorer.
- Look for the `executePayout` / `payoutClaim` instruction — it includes an SPL token transfer from the vault ATA to your wallet ATA.
- Your wallet USDC balance in Phantom should have increased by the payout amount.

---

## 8. Staking & solvency (optional but demonstrates the premium split)

1. Navigate to <http://localhost:3099/staking>.
2. Enter an amount (e.g. `25` USDC) and click **Stake**. Sign the transaction.
3. The **My Position** card shows:
   - Staked USDC
   - Pool share %
   - Pending rewards (appears after a premium is collected — buy a policy after staking and refresh)
4. Request an unstake: click **Request Unstake**. A 48-hour cooldown starts.
5. The **Pool Health** card (and `/protocol`) show the solvency ratio live. After step 7 the `Claims Paid` counter increments and the `Total Staked` / `Solvency Ratio` change accordingly.

**Expected premium split** (enforced on-chain): 70% stakers, 20% reserve, 10% protocol treasury.

---

## 9. Full happy-path smoke test (check-list)

Run through this in order; tick each item.

- [ ] `pnpm dev` boots without errors; <http://localhost:4099/api/health> returns 200.
- [ ] <http://localhost:3099> renders with stats.
- [ ] Phantom (Devnet) connects, header shows truncated address.
- [ ] Wallet has ≥ 1 SOL and ≥ 10 test-USDC.
- [ ] `/dashboard` → **Assess Risk** for your own wallet returns a score; `/assessment/<id>` renders.
- [ ] **Buy Policy** with coverage 50 / 12h / MEDIUM / agent = your second wallet; Phantom signs; explorer link opens.
- [ ] New policy visible in **Your Policies** with state `ACTIVE`.
- [ ] `POST /api/demo/simulate-exploit` with that agent address returns `{ success: true }`.
- [ ] `/claims` shows a new claim; status reaches `paid`.
- [ ] Holder wallet USDC balance increased by the policy coverage.
- [ ] Policy on `/dashboard` now shows state `CLAIMED` with `payoutAmount > 0`.
- [ ] `/staking` → stake 25 USDC; **My Position** updates after the next block.
- [ ] `/protocol` shows non-zero **Total Premiums Collected** and **Claims Paid**.

If any item fails, the first place to look is the API logs (stdout of `pnpm dev`) — every route and worker logs via Pino with the policy / claim ID in context.

---

## 10. Tear-down

```bash
pnpm docker:down            # stop postgres + redis
git checkout -- .           # discard any local dev tweaks
```

To reset state without losing the program deployment, truncate the DB:

```bash
pnpm --filter api run db:push    # re-applies schema; for a hard reset: drop and recreate
pnpm --filter api run db:seed    # optional: reseed demo agents + vault snapshot
```

On-chain state (policies, vault) stays on devnet and is cheap to leave. Redeploy the program only if you change the Rust source:

```bash
pnpm deploy:devnet
```

---

## Appendix — key endpoints & files

| Concern | File / Endpoint |
|---|---|
| Landing page | `packages/web/src/app/page.tsx` |
| Dashboard (risk + policies + buy) | `packages/web/src/app/dashboard/page.tsx` |
| Assessment detail | `packages/web/src/app/assessment/[id]/page.tsx` |
| Claims feed | `packages/web/src/app/claims/page.tsx` |
| Demo (simulate incident) | `packages/web/src/app/demo/page.tsx` |
| Staking | `packages/web/src/app/staking/page.tsx` |
| Protocol stats | `packages/web/src/app/protocol/page.tsx` |
| Wallet adapter | `packages/web/src/providers/WalletProvider.tsx` |
| `GET /api/risk/:agent` | `packages/api/src/routes/risk.ts` |
| `POST /api/policies/quote` | `packages/api/src/routes/policies.ts` |
| `GET /api/policies` | `packages/api/src/routes/policies.ts` |
| `GET /api/claims` | `packages/api/src/routes/claims.ts` |
| `POST /api/demo/simulate-exploit` | `packages/api/src/routes/monitoring.ts` |
| `POST /api/monitoring/webhook` | `packages/api/src/routes/monitoring.ts` |
| `GET /api/staking/:wallet` | `packages/api/src/routes/staking.ts` |
| `GET /api/vault` | `packages/api/src/routes/vault.ts` |
| Risk scoring service | `packages/api/src/services/risk-scorer.ts` |
| Claim oracle | `packages/api/src/services/claim-oracle.ts` |
| Transaction monitor | `packages/api/src/services/transaction-monitor.ts` |
| Expiry / solvency / analytics workers | `packages/api/src/workers/` |
| Anchor program | `packages/anchor/programs/covantic/src/lib.rs` |
