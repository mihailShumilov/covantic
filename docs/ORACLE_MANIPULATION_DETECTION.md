# Oracle Manipulation Detection — Hardening Plan

Branch: `feature/actions-detection-improvement`
Scope: `TriggerType.OracleManipulation` (2) — detection, verification, and settlement.

---

## Implementation status

All eight phases are implemented on `feature/actions-detection-improvement`.
183 tests pass; `tsc --noEmit` and `eslint src/ tests/` are clean.

| Phase | State | Where |
|-------|-------|-------|
| 1 — Evidence spine, block-time anchoring | done | `services/oracle/{types,hash,tx-time}.ts`, `price-sources/pyth-hermes.ts` |
| 2 — Execution reconstruction | done | `services/oracle/{execution,valuation}.ts`, `shared/src/tokens.ts` |
| 3 — Multi-source consensus | done | `services/oracle/{consensus.ts,price-sources/cex.ts}` |
| 4 — Manipulation discriminators | done | `services/oracle/signatures.ts` |
| 5 — Proactive detection | done | `services/oracle/prefilter.ts`, `workers/oracle-watcher.ts` |
| 6 — Trust-minimised settlement | code done, **not deployed** | `anchor/.../verify_and_payout_v2.rs`, `services/oracle/proof-poster.ts` |
| 7 — Determinism and replay | done | `services/oracle/adjudicate.ts`, `scripts/claim-replay.ts` |
| 8 — Validation harness | partial | `tests/fixtures/corpus.ts`, `tests/oracle-corpus.test.ts` |

**Carried forward, with the reason:**

- *Phase 6 deployment.* **IDL generation is fixed** — the program migrated to
  Anchor 1.1.2 (with `pyth-solana-receiver-sdk` 2.0.0), which replaced the
  `anchor-syn` 0.30.1 `Span::source_file()` call that current Rust removed.
  `anchor build` now produces both the binary and the IDL, and the integration
  suite runs. `ORACLE_PROOF_ENABLED` still stays false until the program is
  **redeployed** — the instruction is built but not yet on devnet.
- *Corpus A (real incident replay).* The collector is timestamp-driven so
  mainnet history works unchanged, but 2022 transactions need archival RPC
  access this environment does not have. Cases drop into
  `tests/fixtures/corpus.ts` unchanged when it does.
- *Live devnet attack simulator.* Needs a funded devnet pool with real
  liquidity to manipulate. Not built.
- *Pool-state signals.* `pool_displacement` and `liquidity_drain` need
  reserves at a historical slot. They report as **unevaluated**, never as
  absent, and the confidence score is docked for each check that could not run.
- *Depth-implied slippage.* Not subtracted yet, so `SLIPPAGE_UNCERTAINTY_FLOOR`
  (3%) stands in for it. That biases the loss estimate upward, which is the
  known cost of the gap.

**Coverage limit worth knowing:** liquid staking tokens (JitoSOL, mSOL) are
priced by Pyth alone — no exchange lists them — so they fall below the
three-source bar and route to review rather than auto-confirming. Verified
against live sources: SOL/USD and BTC/USD get four sources, USDC/USD gets
three, JITOSOL/USD gets one.

---

## 0. What "100% proof" can actually mean

Two different things get called "100%", and only one of them is reachable.

**Not reachable:** 100% detection recall. Whether a swap was "manipulated" is an
open-world judgement against an adaptive adversary. Any fixed rule set can be
walked around, and any claim of perfect recall is marketing, not engineering.

**Reachable, and what this plan delivers — provable settlement.** Three hard
guarantees, each testable:

| # | Guarantee | Meaning |
|---|-----------|---------|
| **G1** | **Soundness on the auto-pay lane** | Every automatic payout is backed by a Wormhole-signed Pyth price attestation that the **on-chain program itself verifies**. The backend cannot pay out on a price it invented, and a stolen oracle key cannot drain the vault by asserting a fake loss. |
| **G2** | **Reproducibility** | The verdict is a *pure function* of an immutable evidence bundle. `sha256(bundle)` is committed on-chain. Anyone replaying the bundle gets a byte-identical verdict, forever. |
| **G3** | **No silent failure** | Every claim terminates in exactly one of `paid`, `rejected(reasons[])`, `indeterminate→review`. A claim is never rejected because an upstream API returned 429. |

Recall becomes a *measured, CI-gated metric* against a labelled corpus (§8) rather
than a promise. False positives on the auto-pay lane are driven to zero **by
construction** — anything the evidence does not conclusively support goes to the
review lane instead of being paid.

---

## 1. Current state

```
Helius webhook ──▶ TransactionMonitor.detectAnomalies ──▶ alert bus ──▶ claim-keeper
                     (large_transfer | failed_tx ONLY)                      │
                                                                            ▼
                                                            verifyOracleManipulation
                                                              (Pyth spot price, now)
                                                                            │
                                                                            ▼
                                              oracle_submit_claim ──▶ verify_and_payout
                                                            (chain trusts the amount)
```

| Stage | File | Status |
|-------|------|--------|
| Detection | `packages/api/src/services/transaction-monitor.ts:174` | **Missing.** `detectAnomalies` only emits `large_transfer` and `failed_tx`. |
| Trigger event | `oracle_deviation` | Emitted by **nothing** in production — only `POST /api/demo/simulate-exploit` (`routes/monitoring.ts:188`). |
| Verification | `services/verifiers/oracle-manipulation.ts` | Works, but on the wrong inputs (§2). |
| Settlement | `anchor/.../verify_and_payout.rs:36` | Accepts any `payout_amount ≤ coverage` from the oracle signer. No price evidence checked. |

**Headline finding:** the production detector for the trigger we sell insurance
against does not exist. Every `OracleManipulation` claim today originates from the
demo endpoint. Closing that is Phase 5 and it is the single highest-value item here.

---

## 2. Defect inventory

Ordered by impact on the three guarantees.

### Settlement trust

**D13 — The chain verifies nothing about the price.** `verify_and_payout.rs`
checks `payout_amount ≤ policy.coverage_amount`, the lock period, and that the
signer is `config.oracle_authority`. A compromised oracle key pays itself the full
coverage of every active policy. *Breaks G1.*

**D12 — No evidence is persisted.** `claims.verification_data` keeps a handful of
scalars. The signed price update, the slot, the pool state, the source set — none
of it is stored. Nothing can be audited or replayed after the fact. *Breaks G2.*

### Correctness of the price reference

**D1 — Wrong point in time.** `oracle-manipulation.ts:137` calls
`pyth.getSpotPrice()`, which is the price *at verification time*. The trigger tx
may be minutes or hours old. A quiet 10% market drift between execution and
verification manufactures a payout; a drift the other way hides a real attack.
This is the most severe verification bug.

**D2 — One oracle is used to adjudicate oracle manipulation.** Pyth is both the
reference *and* a plausible attack surface. If the manipulated feed is the one we
price against, the verifier confirms the attacker's price as fair.

**D3 — The confidence interval is thrown away.** `PythClient.getPrice` returns
`conf`; `getSpotPrice` (`utils/pyth.ts:79`) drops it. Pyth's own stated uncertainty
is exactly the right scale for the deviation threshold, and a `conf/price` blowout
is itself a manipulation signal.

**D4 — A transient outage permanently destroys a valid claim.** Hermes 429 or a
network blip → `pyth_unavailable` → `verified:false` → `rejectClaim`
(`claim-keeper.ts:341`). The claim is closed. *Breaks G3.*

### Correctness of the executed price

**D5 — Implied price from the two largest transfer legs.** Multi-hop Jupiter
routes, partial fills, wSOL wrap/unwrap, fee legs, and two swaps in one tx all
mis-price. The code also reads `tokenTransfers[]` while `common.ts` already knows
`accountData[].tokenBalanceChanges` is the authoritative pre/post source
(`netUsdcOutflowRaw`).

**D6 — Pair coverage is effectively zero.** `PRICE_FEED_FOR_MINT` has two entries
(wSOL and native `SOL`); `STABLE_USDC_MINTS` has two. Everything else short-circuits
to `no_pyth_feed`. Non-USDC pairs are impossible even when *both* legs have feeds.

**D9 — Loss ignores the honest cost of trading.** `(implied − spot) × amount`
charges the vault for the DEX fee tier and for the depth-implied slippage the agent
would have paid on an honest venue.

### Discrimination

**D7 — "Price was off" is treated as "price was manipulated."** A 3% gap from spot
is not evidence of an attack. A thin-pool swap, a stale route, or one volatile
minute all clear the bar; a surgical sub-3% manipulation never does. None of the
actual manipulation signatures are examined.

**D8 — Fixed 3% threshold.** Not volatility-adaptive, not size- or depth-adaptive.
Wrong in both directions depending on the pair and the hour.

**D10 — Only DEX-swap manipulation is modelled.** The canonical attack — inflate a
collateral price, borrow against it, walk away (Mango-style) — reads an oracle
inside a lending/perp program and never looks like a mispriced swap. Undetectable
today.

**D11 — Confidence is decorative.** `0.6 + dev × 4.29` (`oracle-manipulation.ts:183`)
gates nothing; `claim-keeper.ts:340` approves on `verified` alone.

### Also worth fixing while in here

**D14** — `syntheticVerification` pays `0.8 × coverage` at confidence `1.0`, gated
only by `NODE_ENV !== 'production'`. Add defence in depth: also require a non-mainnet
cluster **and** a non-mainnet USDC mint.

---

## 3. Target architecture

```
                  ┌──────────────── candidate sources ────────────────┐
  Hermes SSE ─────┤                                                   │
  pool accounts ──┤  workers/oracle-watcher.ts                        │
  Helius webhook ─┤  services/transaction-monitor.ts (pre-filter)     │
  sweeper ────────┤                                                   │
                  └───────────────────────┬───────────────────────────┘
                                          ▼
                         services/oracle/evidence.ts   (all network I/O lives here)
                            ├─ price-sources/pyth-hermes.ts      (historical + signed VAA)
                            ├─ price-sources/switchboard.ts
                            ├─ price-sources/jupiter-quote.ts
                            ├─ price-sources/pool-state.ts       (archival, slot-indexed)
                            ├─ price-sources/cex-reference.ts
                            ├─ execution.ts   (true net swap from balance deltas)
                            └─ signatures.ts  (structural manipulation markers)
                                          │
                                    EvidenceBundle  ──── persisted + hashed
                                          ▼
                         services/oracle/adjudicate.ts   ◀── PURE. no I/O. no clock.
                                          │
                                       Verdict { outcome, loss, confidence, reasons[] }
                                          ▼
              ┌──────────────┬────────────────────┬────────────────────┐
        auto-pay lane    review lane        reject(reasons)       indeterminate
              │                                                    (retry, then review)
              ▼
   post historical PriceUpdateV2  ──▶  verify_and_payout_v2  (chain re-checks the price)
```

Two invariants the layout enforces:

1. **All I/O above the line, all judgement below it.** `adjudicate()` takes a bundle
   and returns a verdict. No `fetch`, no `Date.now()`. That is what makes G2 hold.
2. **The reference price never comes from a single source** — see Phase 3.

---

## 4. Phase 1 — Evidence spine and time correctness

*Fixes D1, D3, D4, D12. Prerequisite for everything else.*

**1.1 Historical, signed prices.** Replace `getSpotPrice` with:

```ts
interface PricePoint {
  value: number;          // decimal price
  conf: number;           // Pyth confidence interval, same units
  publishTime: number;    // unix seconds
  slot: number;           // Pyth metadata.slot
  source: 'pyth' | 'switchboard' | 'jupiter' | 'pool' | 'cex';
  raw: string;            // signed payload — the proof material
}

getPriceAt(feedId: string, unixTime: number): Promise<PricePoint | null>
```

Backed by `GET /v2/updates/price/{publish_time}?ids[]={feed}&parsed=true&binary=true`.
Verified live against Hermes — it returns `parsed[0].price {price, conf, expo,
publish_time}`, `metadata {slot, prev_publish_time}`, **and** `binary.data[0]`, the
hex Wormhole accumulator update. `binary.data[0]` is the artefact the on-chain
receiver verifies in Phase 6 — store it verbatim.

**1.2 Anchor the query to the transaction, not to `now`.**
- Add `slot` to `EnhancedTransaction` (Helius returns it; the local type omits it).
- Cross-check `timestamp` against `getTransaction().blockTime` via `SolanaRpcAnalyzer`.
- Fetch the last update with `publish_time ≤ blockTime` **and** the first with
  `publish_time ≥ blockTime`. Require `|Δt| ≤ 2s`; carry both into the bundle and
  adjudicate against the interval, not a point.

**1.3 Use the confidence interval.** Carry `conf` through. Deviation is measured in
units of `max(conf, σ_floor)`, not raw percent (Phase 4).

**1.4 `indeterminate` as a first-class outcome.**

```ts
type Outcome = 'manipulation' | 'no_manipulation' | 'indeterminate';
interface Verdict { outcome: Outcome; lossAmount: number; confidence: number;
                    reasons: Reason[]; retryAfterSec?: number }
```

`claim-keeper.ts:340` must branch on `outcome`, not on a boolean. `indeterminate`
re-queues with backoff and escalates to review after N attempts. **A source outage
must never close a claim.**

**1.5 Persistence.** New table `claim_evidence`: `claim_id`, `bundle` (jsonb),
`bundle_hash`, `verdict` (jsonb), `verdict_hash`, `adjudicator_version`,
`created_at`. Add `claims.status = 'indeterminate'` and `claims.review_reason`.

**Acceptance.** Replay a real devnet swap: the price used has `publish_time` within
2s of the tx block time. Point Hermes at a dead host: the claim goes
`indeterminate`, retries, and is never rejected.

---

## 5. Phase 2 — Correct execution reconstruction

*Fixes D5, D6, D9.*

**2.1 Net deltas, not transfer legs.** Build the agent's true position change from
`accountData[].tokenBalanceChanges`, netted per mint, including native SOL from
`nativeTransfers` minus `fee`. Then classify explicitly:

| Shape | Handling |
|-------|----------|
| 1 mint out, 1 mint in | normal swap → price it |
| 1 out, N in / N out, 1 in | aggregate the priced side; require every leg priceable |
| N↔N | `unsupported_shape` → review, never auto-reject |
| net zero | `self_transfer` → not a swap |
| wSOL wrap/unwrap present | collapse wSOL and native SOL into one position |

**2.2 Real mint registry.** Move to `@covantic/shared`:
`mint → { feedId, decimals, kind: 'stable' | 'priced' }`. Seed with wSOL, USDC
(mainnet + devnet), USDT, PYUSD, USDS, JitoSOL, mSOL, BTC/ETH wrappers. When **both**
legs are priced, compute the cross rate — drop the "one leg must be USDC" rule
entirely.

**2.3 Honest-cost model.** `excessLoss = executedValue − fairValue − expectedCost`,
where `expectedCost = feeTier(pool) × notional + depthSlippage(poolReserves, size)`.
Pool reserves come from the slot-indexed `pool-state` source. The vault should never
reimburse the fee the agent would have paid on a clean venue.

**Acceptance.** Golden fixtures: Jupiter 3-hop, partial fill, wSOL wrap, two swaps in
one tx, swap plus unrelated transfer. Each produces the correct implied price or an
explicit unsupported classification — never a wrong number.

---

## 6. Phase 3 — Multi-source consensus

*Fixes D2. This is the conceptual core.*

**Rule: never adjudicate manipulation of feed X using only feed X.**

| Source | What it gives | Independence |
|--------|---------------|--------------|
| Pyth Hermes (historical) | signed price + conf at `blockTime` | publisher set A |
| Switchboard On-Demand | independent aggregate | publisher set B |
| Jupiter Quote API | routed execution price at the real size | venue-level |
| On-chain pool state @ slot | `sqrtPrice`/reserves at `slot−1`, `slot`, `slot+1` | the venue itself |
| CEX klines (Coinbase/Binance, 1-min) | fully off-chain reference | out-of-band |

```
fairPrice   = weighted median of available sources
dispersion  = max pairwise relative divergence

require sources ≥ 3          else → indeterminate
require dispersion ≤ D_max   else → indeterminate   (references disagree ⇒ prove nothing)
```

The CEX reference matters more than it looks: it is the only source an on-chain
attacker cannot touch at all. It is the tiebreak when the chain-native sources split.

**Acceptance.** Poison one source in a test harness → verdict unchanged. Poison two
→ `indeterminate`, not a payout. That property test *is* the D2 fix.

---

## 7. Phase 4 — Manipulation discriminators

*Fixes D7, D8, D10. This is what separates an attack from a bad trade.*

### Hard requirements (all must hold for the auto-pay lane)

1. `deviation ≥ adaptiveThreshold` (below)
2. `sources ≥ 3` and `dispersion ≤ D_max`
3. `excessLoss > 0` after the honest-cost model
4. **at least one structural signature** below
5. **reversion confirmed** — the venue price returns to within `D_revert` of consensus
   within `N` slots

### Structural signatures (weighted evidence, ≥1 required)

| Signature | How it is checked | Weight |
|-----------|-------------------|--------|
| **Price reversion** | pool price at `slot+1..slot+N` returns to pre-event consensus | highest — honest moves persist, manipulations snap back |
| Same-slot displacement | pool price at `slot−1` vs `slot` jumps beyond `k·σ` | high |
| Sandwich / atomic pattern | same signer or funder touches the pool immediately before and after in the block | high |
| Flash loan co-occurrence | `FLASH_LOAN_PROGRAMS` in the tx or in the attacker's tx in the same slot | high |
| Oracle conf blowout | Pyth `conf/price` spikes above its trailing baseline at `blockTime` | medium |
| Publisher divergence | one Pyth publisher deviates from the component median | medium |
| Liquidity drain-and-restore | reserves drop >X% then recover within N slots | medium |

### Adaptive threshold (replaces the fixed 3%)

```
adaptiveThreshold = max(
  k  × σ_window(feed, 1h),          // realised volatility
  m  × pythConf / pythPrice,        // the oracle's own uncertainty
  depthSlippage(poolReserves, size),// what an honest trade this size costs
  FLOOR                             // 0.5% — never below the noise band
)
```

### D10 — collateral mispricing sub-detector

New evidence branch for lending/perp interactions: when the tx invokes a lending or
perp program (extend `common.ts` classification), read the oracle account that
program consumed **in the same tx**, and compare the collateral valuation it implies
against the Phase-3 consensus. Flags borrow/withdraw against inflated collateral —
the attack class that never appears as a mispriced swap.

**Acceptance.** Labelled corpus (§8): FP = 0 on negatives, documented recall on
positives, and every verdict carries the `reasons[]` that produced it.

---

## 8. Phase 5 — Proactive detection

*Fixes the "detector does not exist" gap. Highest value per hour of work.*

**5.1 `workers/oracle-watcher.ts`.** Subscribe to the Hermes SSE stream for the feeds
insured agents are exposed to, plus `onAccountChange` for the pools they actually
trade. Raise an `oracle_deviation` candidate on cross-source divergence, a conf
blowout, or a pool-vs-consensus gap — then correlate to insured agents' txs in that
slot window. This detects the *manipulation event*, not just its victim.

**5.2 Cheap pre-filter in `TransactionMonitor.detectAnomalies`.** Insured agent +
DEX program + implied price off the cached consensus by more than a loose bound →
emit `oracle_deviation`. Deliberately loose: the verifier does the expensive,
careful work. This is the smallest change that makes the pipeline real.

**5.3 Sweeper.** Webhooks drop. Periodically pull recent txs for every insured agent
(`getEnhancedTransactions`) and run the pre-filter. Detection must not depend on a
push channel staying up.

**Acceptance.** The devnet attack simulator (§11) produces a claim end-to-end with
the demo endpoint disabled.

---

## 9. Phase 6 — Trust-minimized settlement

*Fixes D13. This is the part that earns the phrase "proof".*

**9.1 On-chain price verification.** Add to `packages/anchor/programs/covantic/Cargo.toml`:

```toml
pyth-solana-receiver-sdk = "x.y.z"
```

New instruction `verify_and_payout_v2(payout_amount: u64, evidence: EvidenceCommitment)`
with `price_update: Account<'info, PriceUpdateV2>` added to the context. On-chain checks:

```rust
// NOT get_price_no_older_than — we are proving a PAST price, not a fresh one.
let price = price_update.get_price_unchecked(&feed_id)?;

require!(feed_id == policy.insured_feed_id,            InvalidFeed);
require!((price.publish_time - evidence.trigger_block_time).abs() <= MAX_SKEW, StalePriceEvidence);
require!(deviation(evidence.executed_price, price.price) >= evidence.threshold_bps, DeviationTooSmall);
require!(payout_amount <= evidence.computed_loss,      PayoutExceedsProvenLoss);
require!(payout_amount <= policy.coverage_amount,      PayoutExceedsCoverage);
policy.evidence_hash = evidence.bundle_hash;
```

`get_price_no_older_than` is wrong here by construction — it fails on anything older
than its `maximum_age`, and every claim we settle is retrospective. Use
`get_price_unchecked` and enforce the *skew against the trigger block time* instead.

**9.2 Posting the historical update.** Off-chain, `@pythnetwork/pyth-solana-receiver`:
`newTransactionBuilder({ closeUpdateAccounts: true })` →
`addPostPriceUpdates([binary.data[0]])` (the blob stored in Phase 1) →
`addPriceConsumerInstructions(...)` emitting `verify_and_payout_v2`. Rent is
reclaimed in the same transaction.

*Constraint:* the Wormhole guardian set that signed the VAA must still be accepted
on-chain. Post the proof inside the existing lock window (oracle manipulation =
1h), not weeks later. The archived binary blob keeps off-chain replay valid forever
regardless.

**9.3 The honest boundary.** The chain can verify the *price* cryptographically. It
cannot read the historical swap transaction, so the *executed* price stays an
oracle-committed input. Three mitigations close that gap as far as Solana allows:

- **(a)** the full bundle is published and its `sha256` committed on-chain — a false
  commitment is permanently, publicly falsifiable;
- **(b)** 2-of-N independent oracle workers co-sign the bundle hash, so one
  compromised key is not sufficient;
- **(c)** the existing 1h lock period doubles as a **challenge window** — anyone may
  submit a contradicting bundle for the same tx, which freezes the payout for review.

State that boundary in the pitch. "The price side is verified on-chain; the execution
side is committed, published, replayable, and challengeable" is a far stronger claim
than an unqualified "100%" that a judge or auditor can puncture in one question.

---

## 10. Phase 7 — Determinism and replay

- `adjudicate(bundle): Verdict` — pure, no network, no clock, version-stamped.
- Canonical JSON serialisation → `bundleHash`; `verdictHash = sha256(bundleHash ‖ verdict)`.
- `pnpm claim:replay <claimId>` re-derives the verdict from stored evidence and
  diffs against what was recorded. Any drift is a bug or tampering.
- Publish bundles to durable storage (S3 with object lock, or IPFS/Arweave) and put
  the hash on-chain.
- Snapshot tests: fixed bundle in → byte-identical verdict out. Bump
  `adjudicator_version` on any intentional change and keep old snapshots green.

---

## 11. Phase 8 — Validation harness

How the recall claim gets *earned* rather than asserted.

| Corpus | Contents | Gate |
|--------|----------|------|
| **A — real positives** | Historical mainnet manipulations replayed through the collector (Mango Oct-2022, Cypher, thin-pool sandwich cases). The collector is timestamp-driven, so mainnet history works unchanged. | recall ≥ target |
| **B — hard negatives** | Honest high-slippage swaps in genuinely volatile minutes, legitimate thin-pool trades, stale-route executions, plain agent-error losses. | **FP = 0** |
| **C — synthetic** | `pnpm attack:simulate` — actually move a thin devnet pool, then swap against it. Real end-to-end positives through the live pipeline. | 100% detected |

Plus: determinism test (same bundle → same verdict), a no-network test proving
`adjudicate` makes zero I/O, and property tests (`loss ≤ coverage`, deviation
monotonic in executed price, `excessLoss ≥ 0`).

CI gate on B is the one that matters: **a regression that creates a false positive
fails the build.** That is the mechanical form of G1.

Operational metrics: verdict distribution, indeterminate rate, per-source
availability, time-to-verdict, challenge-window activity.

---

## 12. Confidence lanes

| Confidence | Conditions | Action |
|-----------|------------|--------|
| ≥ 0.95 | all hard requirements met, on-chain proof verified, challenge window clean | auto-pay |
| 0.70–0.95 | hard requirements met, weak structural evidence | multisig / committee review |
| < 0.70 | requirements unmet | reject with structured `reasons[]`, appeal path open |
| `indeterminate` | sources unavailable or in disagreement | retry with backoff → review. **Never auto-reject.** |

`claim-keeper` currently ignores confidence entirely (D11) — this table is the fix.

---

## 13. Sequencing

**Tier 1 — makes the feature real (~2 days).**
Phase 1 (historical prices, `indeterminate` lane, evidence table) + Phase 5.2
(pre-filter so `oracle_deviation` actually fires) + D14 hardening.
Without these, everything else is polish on a detector that never runs.

**Tier 2 — makes verdicts correct (~3–4 days).**
Phase 2 (execution reconstruction) + Phase 3 (multi-source consensus).

**Tier 3 — makes verdicts defensible (~3–4 days).**
Phase 4 (discriminators, adaptive threshold) + Phase 8 corpora.

**Tier 4 — makes it provable (~3–5 days).**
Phase 6 (on-chain verification) + Phase 7 (replay). This is the headline capability
and the honest answer to "how do you know the payout was justified?"

**Risks / dependencies**
- Slot-indexed historical pool state needs archival RPC (Helius archival or Triton).
- Wormhole guardian-set validity bounds how late a proof can be posted (§9.2).
- Hermes rate limits → cache by `(feedId, slot)`; the mapping is immutable.
- Switchboard devnet feed coverage is thinner than mainnet; degrade to
  `sources ≥ 2` on devnet with the lower confidence lane, never in production.

---

## 14. Immediate next actions

1. `PythClient.getPriceAt(feedId, unixTime)` with signed `binary.data` retained.
2. Add `slot` to `EnhancedTransaction`; resolve `blockTime` for the trigger tx.
3. Introduce `Verdict.outcome` and the `indeterminate` path in `claim-keeper.ts:340`.
4. Create the `claim_evidence` table + `claims.status = 'indeterminate'`.
5. Emit `oracle_deviation` from `TransactionMonitor.detectAnomalies`.
6. Stand up corpus B (hard negatives) and wire the FP = 0 CI gate before tuning
   anything — otherwise the tuning has no ratchet.
