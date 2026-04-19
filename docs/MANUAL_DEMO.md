# Covantic — Manual Demo & QA Guide

End-to-end walkthrough for the Covantic AI Agent Insurance Protocol on Solana devnet.

Covers:

- Connecting your own browser wallet (Phantom / Solflare).
- Running a risk assessment on any devnet address.
- Buying an insurance policy on-chain (gated by an oracle-signed risk
  attestation the API publishes automatically).
- Inspecting your policies, their on-chain PDAs, and claim state.
- Producing a real claim via (a) the synthetic demo button, (b) the agent
  CLI, (c) a real Helius webhook, or (d) the autonomous fleet.
- Reading the oracle's decision on `/claims` and `/fleet`.

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
- `ORACLE_KEYPAIR_PATH=./keys/oracle-keypair.json` — the oracle signs
  `upsert_attestation` (before policy purchase) plus `oracle_submit_claim`
  and `verify_and_payout` (claim pipeline).
- `HELIUS_API_KEY`, `HELIUS_WEBHOOK_SECRET` (64+ chars). The webhook
  endpoint accepts either an HMAC-of-body signature **or** a static
  `Authorization: Bearer <secret>` — real Helius deliveries use the
  bearer path, internal callers/tests use HMAC.
- `WEBHOOK_PUBLIC_URL` — only needed when running `pnpm webhook:sync`
  (e.g. an ngrok / Cloudflare Tunnel URL).
- `ALERT_HMAC_SECRET` — signs messages on the internal `monitoring:alerts`
  Redis channel. The claim-keeper rejects unsigned alerts.
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

Header nav: **Dashboard**, **Fleet**, **Protocol**, **Staking**, **Claims**,
**Demo**.

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

The risk assessment is persisted in Postgres and becomes the input to
`/api/policies/quote` in the next step. **Assessments older than 600 s are
rejected by the quote endpoint** with `code: ASSESSMENT_STALE`, forcing a
re-assess before you can buy.

Edge cases worth poking:

| Input | Expected |
| --- | --- |
| Fresh keypair (no history) | LOW/MEDIUM tier, low confidence |
| An active DeFi wallet | Populated factors, usable score |
| Invalid base58 | Inline error, no call made |
| EXTREME-risk agent | Quote later rejects with `AGENT_UNINSURABLE` |

---

## 4. Buy an insurance policy

Real on-chain transaction — Phantom prompts for signature.

**What happens under the hood**: the buyer no longer picks a tier. Before
the `createPolicy` tx is built, the API publishes (or refreshes) an
oracle-signed **`RiskAttestation` PDA** for the agent via
`upsert_attestation`. On-chain, `create_policy` reads the tier from that
attestation instead of trusting the caller, closing the adverse-selection
hole where buyers could pick LOW for a HIGH agent.

1. `/dashboard` → **Buy Policy** (visible once you have an assessment).
2. Fill the form:
   - Coverage (USDC): e.g. `50`
   - Duration (hours): e.g. `12`
   - Agent Wallet Address: **the address you want to insure.** This can be:
     - Your own connected wallet (insuring yourself)
     - A second wallet you control
     - An agent keypair created via `pnpm agent:create` (see §6b)
     - The built-in RiskyBot demo agent `3kTzqDN8uEZwFEhQKvPXDvMkZxvPcFpHgEL9mJQfYWxC`
3. Premium auto-calculates via `POST /api/policies/quote` (debounced 400 ms).
   The returned `PremiumQuote` includes `riskTier` (derived from the
   assessment, not editable), `assessmentId`, `assessedAt`, `validUntil`,
   `attestationPda`, and `attestationExpiresAt`. The UI shows a live
   "Quote valid for MM:SS" countdown.
4. Confirm → Phantom signs `createPolicy` — the tx includes the
   `attestation` PDA in its accounts list. The on-chain program rejects
   the tx if the attestation doesn't exist, is for a different agent, or
   is expired.
5. Success toast shows a link to the transaction on the explorer and the
   **Your Policies** card refreshes with the new row.

The policy list reads directly from chain, so it's always in sync. Each
row is augmented with a **sidecar enrichment** payload
(`GET /api/policies/enrichment`) that layers on the agent name, current
vs. purchased tier (with a drift warning), claim status, and explorer
links for the policy PDA, create tx, trigger tx, and payout tx.

Quote error codes the UI branches on:

| `code` | Meaning | Recovery |
| --- | --- | --- |
| `ASSESSMENT_REQUIRED` | No risk assessment for this agent | Assess in §3 first |
| `AGENT_UNINSURABLE` | Assessed tier is EXTREME | Pick a different agent |
| `ASSESSMENT_STALE` | Assessment > 600 s old | Re-assess in §3 |
| `ATTESTATION_PUBLISH_FAILED` | Oracle couldn't write the PDA (RPC issue) | Retry in a moment |

Other edge cases:

- Wallet without USDC → ATA error. Re-fund via `pnpm fund:phantom`.
- Wallet without SOL → insufficient fees. Airdrop SOL.
- Coverage/duration outside shared `COVERAGE_LIMITS` → form validation fails.

---

## 5. See your on-chain transactions

Three equivalent views of the same data:

### Dashboard

`/dashboard` → **Your Policies** reads on-chain via
`program.account.insurancePolicy.all()`. Each row shows id, state badge,
tier (purchased + current, with a drift warning if the agent has gotten
worse), coverage, premium, expiry, agent identity, and links to the
Solana Explorer for the **agent**, **policy PDA**, **create tx**,
**trigger tx**, and **payout tx**. After a claim pays out, it also
surfaces **Paid out: $X USDC**.

### API (indexed)

The policy indexer worker mirrors chain state into Postgres every 60 s, so:

```bash
curl 'http://localhost:4099/api/policies?holder=<YOUR_WALLET>'
```

returns the same policies with DB metadata. Useful for scripts and assertions.

### Explorer

Click any tx signature link for the full instruction breakdown at
`https://explorer.solana.com/tx/<sig>?cluster=devnet`.

### Diagnostic endpoints (new)

- `GET /api/monitoring/metrics` — cumulative counters (matched,
  skipped-uninsured, skipped-inactive, anomalies) plus a `policyLag`
  block surfacing policies stuck in `Active` past their expiry. Handy
  when debugging "webhook fired but nothing happened".
- `GET /api/policies/:policyId/why-active` — side-by-side DB vs on-chain
  view of a single policy, with a `diagnosis` array naming every
  inconsistency (state drift, expired-but-Active, stale indexer, PDA
  missing, etc).

---

## 6. Simulate an incident

This is the path that produces real on-chain claims and payouts. Four
ways to kick it off, in order of ceremony.

### 6a. Demo agent (one-click, for screen recording)

The `/demo` page hard-codes the RiskyBot agent address. If you purchased a
policy against that address in §4, the flow is:

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

### 6b. Your own agent (real on-chain activity)

The `agent:*` CLI lets you spin up a throwaway agent keypair, fund it,
and sign real transactions from it — no synthetic shortcut required.

```bash
pnpm agent:create --name risky-1                   # writes keys/agents/risky-1.json
pnpm agent:fund   --name risky-1 --sol 0.5 --usdc 5000
# Buy a policy against the agent via the dashboard (§4).
pnpm agent:trigger --name risky-1 --amount 2000    # real SPL-USDC transfer
```

The trigger tx defaults to a 2,000 USDC transfer — above the 1,000 USDC
`LARGE_TRANSFER_THRESHOLD`. `TransactionMonitor` flags it as a
`large_transfer` anomaly, publishes a signed alert on the
`monitoring:alerts` bus, and the claim-keeper drives the on-chain
submit + payout.

You can also fire the synthetic path at an arbitrary agent without the
CLI:

```bash
curl -X POST http://localhost:4099/api/demo/simulate-exploit \
  -H 'content-type: application/json' \
  -d '{"agentAddress":"<YOUR_AGENT_WALLET>","type":"exploit"}'
```

Supported `type` values: `exploit`, `oracle_deviation`, `agent_error`,
`governance_attack`. The `/api/demo/*` routes are gated by `NODE_ENV` so
they can't be hit in production.

### 6c. Real Helius webhook (production path)

For the real signal path, register a Helius webhook that points at
`/api/monitoring/webhook`.

```bash
# Expose the API publicly, e.g. with ngrok:
ngrok http 4099
# Set WEBHOOK_PUBLIC_URL=<the ngrok https URL> in .env
pnpm webhook:sync
```

`webhook:sync` is idempotent: it reads every distinct insured agent
address from the `policies` table (state=Active), normalises the
endpoint to `<public>/api/monitoring/webhook`, and calls Helius v0 to
create-or-edit the single webhook tied to this deployment. Re-run it
whenever you add new insured agents.

Helius delivers to `POST /api/monitoring/webhook` with
`Authorization: Bearer <HELIUS_WEBHOOK_SECRET>`. The endpoint accepts
either that static token OR an HMAC-of-body signature on
`x-helius-hmac-signature` (the HMAC path is used by tests and internal
callers; real Helius only sends the bearer token). Everything else gets
401.

`TransactionMonitor` runs large-transfer / failed-tx detection per
transaction, publishes to `monitoring:alerts`, and the keeper handles
the rest. See `packages/api/src/services/transaction-monitor.ts` for
thresholds. Real (87–88 char Base58) signatures route through
`claim-oracle.ts` → per-trigger verifiers in
`packages/api/src/services/verifiers/` — exploit, oracle-manipulation,
agent-error, governance-attack — each of which inspects the parsed
transaction and returns a real loss amount + confidence.

### 6d. Autonomous fleet (long-running realism)

For a hands-off demo, bootstrap a fleet of agents that each loop
`act → publish → sleep`.

```bash
# 1. Create N funded agents, each with an insurance policy bought by the fleet holder.
pnpm fleet:bootstrap --count 5 --coverage 200 --duration 86400
#    - generates keys/agents/fleet-*.json + keys/fleet-holder.json
#    - airdrops SOL, mints mock USDC to each
#    - calls /api/risk and /api/policies/quote (which publishes the
#      RiskAttestation PDA) and signs `createPolicy` with the fleet holder
#    - writes keys/fleet.json (the manifest)

# 2. Start the fleet. Each agent loops every 45–90 s, rolling
#    safe-transfer / skip / rogue-large-transfer / failing-tx per its profile.
pnpm fleet:start

# 3. Watch /fleet in the browser or:
pnpm fleet:status
```

Every action appends a compact record to the Redis list
`covantic:fleet:activity` (capped at 500). `GET /api/fleet` returns the
manifest + the latest entries, and `/fleet` polls it every 6 s — left
column = one card per agent, right column = a live activity feed with
explorer links.

When the fleet misbehaves (a "rogue" large transfer or a failing tx),
the webhook + keeper pipeline from §6c kicks in against the fleet's
policies. Real claim, real payout, no synthetic injection.

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

### /fleet

For fleet-originated claims, `/fleet` shows the triggering action inline
in the activity feed (kind `LARGE TRANSFER` / `failing tx`) with a
signature link. The resulting claim still flows through `/claims` — the
two views share the same underlying data.

---

## 8. Staking / protocol (for completeness)

Stakers are what the keeper can pay out against. Without staked USDC the
pipeline will reach `approved` and then fail at payout with
`InsufficientVaultBalance`.

- `/staking`: stake USDC, request + execute unstake (48 h cooldown),
  claim rewards (live accumulator surface, not a placeholder).
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
- [ ] `/dashboard` → **Buy Policy** 50 USDC / 12 h / agent = your test wallet;
      quote shows a derived tier + countdown and the buy succeeds
      (attestation PDA is published transparently).
- [ ] New policy shows `ACTIVE` in **Your Policies** with a live explorer link.
- [ ] `GET /api/policies?holder=<WALLET>` returns that policy (indexer worked).
- [ ] Fire an incident for that agent (UI if RiskyBot, else `pnpm agent:trigger`
      or the `/api/demo` curl in §6b).
- [ ] `/claims` shows the claim; status reaches `paid`.
- [ ] Payout and submit tx links open real explorer pages on devnet.
- [ ] Phantom USDC balance increased by the payout amount.
- [ ] `/dashboard` policy now `CLAIM_PAID` with the payout surface visible.
- [ ] `/protocol` counters — Claims Paid / Total Premiums — incremented.
- [ ] `GET /api/monitoring/metrics` shows non-zero `monitor.matched` and
      `policyLag.stuckCount === 0`.

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

Fleet reset:

```bash
rm -f keys/fleet.json keys/agents/fleet-*.json keys/fleet-holder.json
# then re-run pnpm fleet:bootstrap
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
| Fleet dashboard | `packages/web/src/app/fleet/page.tsx` |
| Staking / Protocol | `packages/web/src/app/staking/page.tsx`, `protocol/page.tsx` |
| `POST /api/policies/quote`, `GET /api/policies`, `GET /api/policies/enrichment`, `GET /api/policies/:id/why-active` | `packages/api/src/routes/policies.ts` |
| `GET /api/claims` | `packages/api/src/routes/claims.ts` |
| `GET /api/fleet` | `packages/api/src/routes/fleet.ts` |
| `POST /api/demo/simulate-exploit`, `POST /api/monitoring/webhook`, `GET /api/monitoring/metrics` | `packages/api/src/routes/monitoring.ts` |
| Attestation publisher (oracle-signed) | `packages/api/src/services/attestation-publisher.ts` |
| Per-trigger claim verifiers | `packages/api/src/services/verifiers/{exploit,oracle-manipulation,agent-error,governance-attack}.ts` |
| Fleet actions + manifest | `packages/api/src/services/fleet/{actions,manifest,types}.ts` |
| Helius webhook sync | `packages/api/src/services/helius-webhook.ts`, `scripts/sync-helius-webhook.ts` |
| Policy indexer | `packages/api/src/workers/policy-indexer.ts` |
| Claim-keeper (auto-claim pipeline) | `packages/api/src/workers/claim-keeper.ts` |
| `upsert_attestation` instruction (oracle-only) | `packages/anchor/programs/covantic/src/instructions/upsert_attestation.rs` |
| `create_policy` (reads attestation, no client-supplied tier) | `packages/anchor/programs/covantic/src/instructions/create_policy.rs` |
| `oracle_submit_claim` / `verify_and_payout` | `packages/anchor/programs/covantic/src/instructions/{oracle_submit_claim,verify_and_payout}.rs` |
| WebSocket `/ws` (`claims:feed`, `vault:stats`, `monitoring:alerts`) | `packages/api/src/index.ts`, `services/notification-service.ts` |
| Agent wallet CLI | `packages/api/scripts/agent-wallet.ts` (`pnpm agent:{create,fund,trigger}`) |
| Fleet CLI | `packages/api/scripts/fleet-{bootstrap,start,status}.ts` |
