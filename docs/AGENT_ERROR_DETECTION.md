# Critical Agent Error Detection — Hardening Plan

Scope: `TriggerType.AgentError` (3) — detection, verification, and settlement.
Fourth and last of the trigger hardening plans, after
[`ORACLE_MANIPULATION_DETECTION.md`](./ORACLE_MANIPULATION_DETECTION.md),
[`EXPLOIT_DETECTION.md`](./EXPLOIT_DETECTION.md) and
[`GOVERNANCE_ATTACK_DETECTION.md`](./GOVERNANCE_ATTACK_DETECTION.md).

This one is different from the other three, and the difference decides the
whole design. Oracle manipulation is provable because Pyth hands the chain a
guardian-signed statement about a past price. An exploit is provable in
magnitude because the program can read a balance twice and subtract. A
governance takeover is provable because the holder declares in advance who may
control the agent and the program performs a set-membership test.

An _agent error_ is a loss the agent caused **with its own authority**. It is
precisely the case `adjudicateExploit` rejects as `agent_authorized_movement`.
Nothing on chain distinguishes a mistake from a decision, because the
distinction lives in the holder's intent — and intent is not a fact any
instruction can read.

So the plan does not try to prove intent. It makes the holder **pre-commit**
to it, exactly as the governance path made them pre-commit to an authority
set, and then has the program check reality against the holder's own
statement. That changes what the trigger covers, and §0 says so plainly rather
than burying it.

---

## Implementation status

All ten phases are implemented. 437 API tests and 56 Anchor integration tests
pass; `tsc --noEmit` and `eslint src` are clean; `cargo check` is clean and
`anchor build --no-idl --ignore-keys` produces the program binary with no
stack-frame overflow.

| Phase                                         | State                       | Where                                                                                                                             |
| --------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Stop the bleeding                         | done                        | `services/event-vocabulary.ts`, `services/transaction-monitor.ts`                                                                 |
| 1 — Mandate on chain                          | code done, **not deployed** | `anchor/.../state/agent_mandate.rs`, `anchor/.../instructions/declare_agent_mandate.rs`                                           |
| 2 — Mandate reader + pure breach evaluator    | done                        | `services/agent-error/{mandate,breach}.ts`                                                                                        |
| 3 — Outflow baseline                          | done                        | `services/agent-error/baseline.ts`, `db/migrations/0003_agent_outflow_history.sql`                                                |
| 4 — Detection that fires                      | done                        | `services/agent-error/prefilter.ts`, `transaction-monitor.ts`                                                                     |
| 5 — Evidence bundle, pure adjudicator, replay | done                        | `services/agent-error/{types,adjudicate}.ts`, `scripts/claim-replay.ts`                                                           |
| 6 — Trust-minimised settlement                | code done, **not deployed** | `anchor/.../instructions/verify_and_payout_agent_error.rs`, `services/agent-error/proof-poster.ts`, `services/settlement-plan.ts` |
| 7 — Trigger re-attribution                    | done                        | `workers/claim-keeper.ts`                                                                                                         |
| 8 — Validation harness                        | done                        | `tests/fixtures/agent-error-corpus.ts`, `tests/agent-error-{corpus,adjudicate,breach}.test.ts`                                    |
| 9 — Holder CLI                                | done                        | `scripts/declare-agent-mandate.ts` (`pnpm mandate:declare`)                                                                       |

**Corpus result:** 5/5 breach shapes confirmed (recall 1.0 against a 0.8
floor), 0/11 operational shapes confirmed. The negative set includes every
shape the retired verifier paid out on.

**Carried forward, with the reason:**

- _Deployment._ `AGENT_ERROR_PROOF_ENABLED` stays false until the program is
  redeployed — it rides the same pending redeploy as the other three flags.
  This one is the flag to be careful with: see §10.
- _Underwriting cannot price the envelope._ The plan's Phase 9 was "the quote
  path reads the mandate", and it turns out to be **impossible as designed**.
  See §16 — this is the one place the plan was wrong rather than merely
  incomplete, and the mitigation that shipped instead is narrower than pricing
  would have been.
- _No UI._ Declaring a mandate is a CLI (`pnpm mandate:declare`), exactly as
  declaring a governance baseline is. Both need a UI.
- _Non-USDC assets._ The mandate is denominated in the covered mint, and the
  settlement instruction reads only the covered ATA. An agent that loses SOL
  or a non-covered SPL token outside its envelope is not covered here.
- _Real-incident replay._ **Done** for the pipeline as a whole — 320 real
  mainnet transactions through all four triggers, zero confirmations. The
  corpus here still holds breach _shapes_, because an agent-error claim needs
  a declared mandate and none of those wallets has one, so every real
  transaction resolves to review on this path. See `M1_RESULTS.md` §2.3.

---

## Found while building

Four things the plan did not anticipate. The first two were defects in the
existing system that this work uncovered; the last two are places the plan's
own design was wrong.

### `bundleHash` never reached `verificationData`, so no proof path could settle

`planProvenSettlement` refuses to route a claim to a proven instruction unless
the claim's `verificationData` carries `bundleHash`. Only the price verifier
folded it into its own `details`; the exploit and governance verifiers did not.

So with `EXPLOIT_PROOF_ENABLED` or `GOVERNANCE_PROOF_ENABLED` switched on,
**every** claim on those triggers would have planned
`unprovable: no_bundle_hash` and gone to review. The proven path was
unreachable — failing closed, and therefore silently. It had never been
exercised because both flags are false pending the redeploy.

Fixed centrally rather than per-verifier: `recordEvidence` already computes the
hash to write the `claim_evidence` row, so it now returns it and the keeper
folds it into the persisted `verificationData`. One place, all four triggers,
and a new trigger cannot reintroduce the gap by forgetting to copy a line.

### `large_transfer` would have re-created the blockage `failed_tx` caused

§1 describes how a single failed transaction blocks all claim origination for a
policy. The plan's Phase 0 severed `failed_tx` from claim origination and left
`large_transfer` mapped to AgentError.

That would have reproduced the same bug through a different event within a
release. Once the verifier answers `no_mandate_declared → review` instead of
guessing, every ≥1,000-USD movement by an agent with no mandate opens a claim,
resolves to `review` — an OPEN status — and occupies the policy's single
open-claim slot indefinitely.

So `large_transfer` is now unmapped too, and the rule is sharper than the plan
had it: **only the mandate-relative signal opens an agent-error claim.** A
signal that cannot reference a declaration cannot describe the covered event.
The monitor still raises, records and alerts on both.

### The categorical fallback would have made the guarantee conditional

§10 of the plan proposed settling a categorical breach — right size, wrong
destination — bounded by the measured drop, with `categorical` recorded on
chain.

That was wrong, and the corpus is what made it obvious. The chain cannot see a
past transaction's destination, so such a payout is the chain releasing funds
on the oracle's unverifiable word, bounded only by a drop that says nothing
about whether anything went wrong. Worse, `categorical` would have been an
oracle-supplied boolean selecting which bound applied — discretion, inside a
proof path.

`verify_and_payout_agent_error` therefore settles **only** breaches it can
measure. A categorical-only breach still confirms off chain and still reaches a
human; it simply never reaches the instruction. `planProvenSettlement` fails it
closed as `breach_not_chain_checkable`, which matters because a payout that
reverts is marked `failed`, not `review` — turning a valid claim into a dead
one. The guarantee is now unconditional: _every proven agent-error payout is
bounded by an overshoot above a cap the holder signed for._

### Seeding `prev_*` from the new declaration silently disabled the maturity delay

`envelope_at` falls back to `prev_*` when the current declaration had not
matured before the claim. The natural thing to write for a _first_ declaration
is `prev_* = the new values, prev_effective_at = now` — which is what
`declare_governance_baseline` does for its own `prev_token_owner`.

Here that destroys the mechanism completely: the fallback makes a brand-new
declaration usable as proof the instant it is written, which is exactly what
the hour-long delay exists to prevent. The Anchor test
_"refuses a mandate that had not matured when the claim was filed"_ caught it.
A first declaration now has `prev_effective_at = 0`, which fails the maturity
check and sends the claim to a reviewer.

---

## 0. What "100% proof" can actually mean here

The same split as the other three plans, with one addition that is specific to
this trigger and is a **product decision, not an engineering one**.

**Not reachable: 100% detection recall.** "Did the agent make a mistake?" is
an open-world judgement. Any fixed rule set can be walked around, and here the
adversary includes the holder, who profits from a loss being classified as an
error. Recall is a measured, CI-gated number against a labelled corpus (§12),
never a promise.

**Not reachable, and this is the addition: proof of intent.** No instruction
can establish that an authorised transfer was unintended. Every scheme that
claims otherwise is inferring intent from shape — which is what the current
verifier does, and §2 is a catalogue of what that costs.

**Reachable: a covered event that is defined by the holder in advance.** If
the holder declares the envelope their agent is permitted to operate in — how
much it may move at once, over a window, to whom, through what, and what
balance it must never fall below — then "critical agent error" becomes
**"the agent breached the mandate its holder declared for it, and lost money
doing so."** That is falsifiable, pre-committed, and partly checkable by the
program itself.

This narrows the covered event. An agent that loses money _inside_ its
declared envelope is not covered, because its owner said that was permitted.
The narrowing is not a concession — it is the entire mechanism. It is the same
trade the governance trigger already made when it replaced "was this
authorised?" with "is this in the declared set?".

With that definition, three guarantees, each testable:

| #      | Guarantee                          | Meaning for an agent-error claim                                                                                                                                                                                                                                                                                                                           |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | **Soundness on the auto-pay lane** | `verify_and_payout_agent_error` reads the covered token account itself, compares it against a checkpoint the program wrote earlier, and refuses to pay more than the drop it measured **or** more than the amount by which that drop exceeded a cap the holder signed for and which matured before the claim was filed. The oracle chooses neither number. |
| **G2** | **Reproducibility**                | The verdict is a pure function of an immutable evidence bundle. `sha256(bundle)` is committed on chain. `pnpm claim:replay` re-derives it forever. Today this trigger produces **no bundle at all** (§2).                                                                                                                                                  |
| **G3** | **No silent failure**              | Every claim ends in exactly one of `paid`, `rejected(reason)`, `indeterminate→review`. A missing mandate is `review`, never a rejection: the absence of a declaration is a gap in our records, not evidence against the holder.                                                                                                                            |

The honest boundary, stated once and repeated where it bites (§10): **the chain
can prove how much left and that it exceeded a declared cap. It cannot see the
route or the counterparty of a past transaction.** Breaches of the destination
and program dimensions of a mandate stay off-chain assertions, bounded by a
drop the chain measured and committed to a bundle anyone can falsify.

---

## 1. Current state

```
Helius webhook ──▶ TransactionMonitor.detectAnomalies ──▶ alert bus ──▶ claim-keeper
                   large_transfer  (any mint, >1,000 units)                 │
                   failed_tx       (any transactionError)                   ▼
                                                                     verifyAgentError
                                                            (program-membership heuristic,
                                                             no evidence bundle)
                                                                            │
                                                                            ▼
                                                        planProvenSettlement ──▶ legacy
                                                        decideLane           ──▶ review
```

| Stage                           | File                                  | Status                                                                                                                                                    |
| ------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detection — size                | `services/transaction-monitor.ts:264` | Fires on `>1,000` summed `tokenAmount` **across every mint**, unit-blind.                                                                                 |
| Detection — failure             | `services/transaction-monitor.ts:273` | Fires on any `transactionError`.                                                                                                                          |
| Detection — the advertised rule | —                                     | **Does not exist.** README and the coverage table promise "Transfer >100x agent average". No per-agent transfer average is computed anywhere in the repo. |
| Verification                    | `services/verifiers/agent-error.ts`   | Program-membership decision tree. No evidence bundle, no adjudicator, no version.                                                                         |
| Replay                          | `scripts/claim-replay.ts:54`          | `engineFor` has no case for trigger 3 → every agent-error claim is `not_replayable`.                                                                      |
| Settlement                      | `services/settlement-plan.ts:80`      | Falls through to `legacy` by explicit comment: _"Agent error has no proof path."_                                                                         |
| Lane                            | `services/confidence-lanes.ts:85`     | `hasProofPath(3)` is false → every confirmed claim is escalated.                                                                                          |

**Headline finding: this trigger is currently a denial-of-coverage vector
against the other three, and the project's own fleet manufactures it on
purpose.**

The chain is short and each link is in the repo:

1. `executeFail` (`services/fleet/failures.ts`) makes fleet agents land real
   failing transactions on chain — deliberately, so the `failed_tx` branch has
   material.
2. `detectAnomalies` raises `failed_tx` for any `transactionError`.
3. `EVENT_TO_TRIGGER` maps `failed_tx → TriggerType.AgentError`, so the keeper
   inserts a claim row immediately, before any verification
   (`claim-keeper.ts:276`).
4. `verifyAgentError` confirms it at **confidence 0.6** with an **invented flat
   1 USDC loss**.
5. `decideLane` sees 0.6 < `REVIEW_CONFIDENCE` (0.75) and parks the claim in
   `review`.
6. `review` is an **open** status (`OPEN_CLAIM_STATUSES`,
   `claims_open_unique`), so from that moment every further alert for that
   policy — including a genuine `exploit` or `governance_attack` — hits a
   unique violation and is dropped with an `info` log
   (`claim-keeper.ts:290`).

One failed transaction by an insured agent therefore blocks all claim
origination for that policy until a human clears the review queue. No alarm
fires; the log line reads like normal deduplication.

Second finding, worth separating because it is what costs money the day
anyone raises a confidence number or flips a flag: the verifier's default
branch confirms **any** ≥1,000 USDC outflow through **any** program that is
not in a ten-entry DEX list. That is the exact false-positive engine the
exploit plan retired (`EXPLOIT_DETECTION.md` §2) and the CLAUDE.md invariant
forbids reintroducing — it simply survived in this file, because the exploit
work replaced `verifiers/exploit.ts` and left `verifiers/agent-error.ts`
alone.

---

## 2. Defect inventory

Ordered by impact on the three guarantees.

### Definition

**D1 — The covered event is not defined.** "Critical Agent Error" has no
written definition anywhere in the codebase that a verifier could implement.
The coverage table's "Transfer >100x agent average" is the closest thing, and
nothing implements it. Every other defect below is downstream of this one: a
verifier with no definition to check against will check against something,
and what it chose was which programs appeared in the transaction.

**D2 — The trigger is the dumping ground.** `EVENT_TO_TRIGGER` routes three
different event types here (`agent_error`, `large_transfer`, `failed_tx`), two
of which describe _observations_ rather than _losses_. A trigger that means
three things means none.

### Settlement trust

**S1 — No proof path.** `planProvenSettlement` routes trigger 3 to `legacy`,
where the program checks only that the caller is the oracle and that
`payout_amount ≤ coverage`. A stolen oracle key is worth the full coverage of
every active policy on this trigger, with nothing on chain to contradict it
afterwards. G1 fails outright.

**S2 — No evidence bundle.** `verifyAgentError` never sets `result.evidence`,
so `recordEvidence` returns early: no `claim_evidence` row, no `bundle_hash`,
no `verdict_hash`, no `adjudicator_version` beyond the placeholder
`verifier-t3`. G2 fails outright — an agent-error payout is not reproducible
even in principle.

**S3 — The lane escalation is load-bearing by accident.** Today every
confirmed agent-error claim goes to `review`, which reads like safety. It is
not a designed property: raising any confidence constant above 0.75, or adding
a proof path without the rest of this plan, silently moves this verifier onto
the auto-pay lane with the heuristics of §2 intact.

### Verification correctness

**V1 — An invented loss.** The `failed_tx` branch approves a flat 1 USDC
because "we can't cleanly convert [lamport fees] to USDC without a price
read". Nobody lost 1 USDC. The real loss is a few thousand lamports of fees.
This is a fabricated number on a payout path, and it sits above
`MIN_LOSS_RAW`, so it confirms.

**V2 — A reverted transaction is not a loss.** `adjudicateExploit` already
states the correct reading — _"Transaction reverted; no funds moved. Fee-only
loss is not an exploit"_ — and hands it to this trigger. This trigger should
hand it back: fee burn is an operational signal, not a covered event, unless
the product decides to cover it explicitly with a declared threshold.

**V3 — Program membership decides the verdict.** `dex → reject`,
`flashLoan → confirm 0.85`, `bridge → confirm 0.5`, `unknown → confirm 0.6`.
Both directions are wrong: a bridge transfer to the holder's own address on
another chain is confirmed at 0.5, and a catastrophic misrouted swap through
Jupiter is rejected outright as `dex_trade`.

**V4 — Authorization is never established.** The verifier takes an
`EnhancedTransaction` and no `Connection`. It cannot see signer flags,
transfer authorities, delegates, or destination ownership. It therefore cannot
tell an agent error (agent's own authority) from an exploit (someone else's) —
which is the one distinction that defines this trigger against its neighbour.

**V5 — No holder-destination check.** `isSelfTransfer` compares against the
agent address only. Value landing in an account the _holder_ controls is the
holder moving their own money; the exploit path checks this
(`authorization.allDestinationsSelf`), this one does not.

### Detection

**T1 — The size screen is mint-blind.** `detectAnomalies` sums
`tokenTransfers[].tokenAmount` with no reference to the mint. 1,001 units of a
worthless airdrop token trips it; 0.4 WBTC does not. The threshold is a count
of tokens, compared against a number that was reasoned about as dollars.

**T2 — The advertised rule is unimplemented.** "100x agent average" requires a
per-agent outflow history. `agent_balance_snapshots` records _holdings_, not
_flows_, and nothing derives an average from it.

**T3 — `failed_tx` has no rate dimension.** One failure and a hundred
failures produce identical, individually-claimable events. If broken-agent
behaviour is worth covering at all, it is worth covering as a _rate_, and the
loss is fee burn over a window — a quantity nothing currently measures.

**T4 — Specificity ranking is right but untested at the boundary.**
`large_transfer` (1) and `agent_error` (2) sit below `exploit` (4) and
`governance_attack` (5), which is correct. But no corpus case exercises the
crossover — an authorised over-mandate drain that also looks like an exploit —
so the ranking is asserted, not verified.

---

## 3. Target architecture

```
                    holder, in advance
                          │
                          ▼
           declare_agent_mandate  ──▶  PolicyAgentMandate PDA
           (holder-signed, matures after MANDATE_DECLARATION_DELAY,
            retains prev_*)
                          │
   Helius webhook         │              exploit-watcher crank (existing)
        │                 │                        │
        ▼                 │                        ▼
  screenForMandateBreach ─┘            checkpoint_balance  (existing)
  (value-denominated, mandate-relative,   PolicyBalanceCheckpoint PDA
   history-relative)
        │
        ▼
   agent_error alert ──▶ claim-keeper ──▶ collectAgentErrorEvidence  (all I/O)
                                                  │
                                                  ▼
                                        AgentErrorEvidenceBundle
                                                  │
                                                  ▼
                                     adjudicateAgentError(bundle)   ← pure
                                                  │
                    ┌─────────────────────────────┼─────────────────────┐
                    ▼                             ▼                     ▼
                rejected                   indeterminate            confirmed
           (within_mandate,                  (no mandate,          lossAmount =
            not_agent_authorized,             no chain record,      excess over
            self_transfer,                    unpriceable)          the envelope
            no_net_loss)                          │                     │
                                                  ▼                     ▼
                                                review        verify_and_payout_agent_error
                                                              (chain re-measures the drop,
                                                               re-checks the cap,
                                                               commits bundle_hash)
```

Three properties carry the design, each borrowed from a sibling plan because
each was already proven there:

- **Consent is declared, not inferred** — from the governance path. The
  mandate is holder-signed and matures on a delay, so a fraudulent claim must
  pre-commit on chain, publicly, before the incident it is meant to justify.
- **Magnitude is measured, not attested** — from the exploit path. The program
  reads the covered account it derives itself and subtracts. The oracle never
  supplies the number.
- **The verdict is a pure function of a committed bundle** — from the price
  path. No I/O, no clock, no randomness in `adjudicateAgentError`.

---

## 4. Phase 0 — Stop the bleeding

No new on-chain code, no redeploy, no new dependencies. Three edits that
remove the denial-of-coverage vector and the false-positive engine.

**0.1 — Sever `failed_tx` from claim origination.**

```ts
// services/event-vocabulary.ts
[MonitoringEventType.FailedTx]: undefined,
```

`undefined` is a decision the map already models
(`balance_drop_unexplained`): the event is real and worth recording, but
there is nothing for a verifier to verify. A reverted transaction moved no
funds; its cost is fee burn, which §8 covers as a declared, measured window
quantity or not at all. This single line breaks the chain in §1 at step 3.

**0.2 — Make the size screen mint-aware.** `WebhookTransaction.tokenTransfers`
must carry `mint`, and the threshold must be compared against value, not a
count of tokens. Until Phase 4 lands the full valuation path, restricting the
screen to the covered mint (`config.USDC_MINT`) is strictly better than
summing across all of them, and is a two-line change.

**0.3 — Retire the program-membership branches.** Delete the `dex` /
`bridge` / `flashLoan` / `unknown` decision tree and the invented 1 USDC loss.
Until a mandate exists to check against, `verifyAgentError` returns
`indeterminate` with reason `no_mandate_declared` and a 30-minute retry, which
routes to `review`.

That is a deliberate downgrade to "a human decides", and it is the same
posture the governance path held between its code landing and its flag being
enabled. It trades away automatic agent-error payouts — which today all end in
`review` anyway (§1) — for the removal of a verifier that confirms bridge
transfers at 0.5 confidence.

**Ordering note.** 0.1 must land with 0.3, not after it. On its own, 0.3
leaves `failed_tx` opening claims that resolve `indeterminate → review`, which
is the same blocking behaviour by a different route.

---

## 5. Phase 1 — The mandate on chain

New account, one per policy, mirroring `GovernanceBaseline` in structure and
in the reasoning behind every field.

```rust
#[account]
pub struct PolicyAgentMandate {
    pub policy_id: u64,
    pub holder: Pubkey,

    /// Largest single outflow, in base units of the covered mint, that the
    /// agent is permitted to make. The chain checks this one itself.
    pub max_single_outflow: u64,
    /// Largest cumulative outflow over `window_seconds`.
    pub max_window_outflow: u64,
    pub window_seconds: i64,
    /// Balance the agent must never take the covered account below.
    pub min_retained_balance: u64,

    /// Destinations the agent may send value to. Fixed-size, with an explicit
    /// count: the zero pubkey must never read as permitted.
    pub allowed_counterparties: [Pubkey; MAX_MANDATE_COUNTERPARTIES],
    pub counterparty_count: u8,
    /// Programs the agent may move value through.
    pub allowed_programs: [Pubkey; MAX_MANDATE_PROGRAMS],
    pub program_count: u8,

    /// sha256 of the off-chain mandate covering anything richer than the
    /// fields above — per-venue caps, slippage bounds, rate limits.
    /// Committed, not interpreted.
    pub manifest_hash: [u8; 32],

    pub declared_at: i64,
    /// When this declaration becomes usable as proof.
    pub effective_at: i64,

    /// The declaration this one replaced. A rotation landing between the
    /// incident and the claim must not erase the only usable "before".
    pub prev_max_single_outflow: u64,
    pub prev_min_retained_balance: u64,
    pub prev_effective_at: i64,

    pub bump: u8,
}
```

`declare_agent_mandate` is holder-signed, requires `PolicyState::Active`,
rejects the zero pubkey in either allowlist, and sets
`effective_at = now + MANDATE_DECLARATION_DELAY`.

**Why the delay is the mechanism and not a formality.** A mandate that could
be written and claimed against in the same breath would prove nothing: a
holder who wanted to convert an ordinary loss into a covered one would simply
declare a mandate narrow enough to have been breached, retroactively. With the
delay, and with `verify_and_payout_agent_error` refusing a mandate that had
not matured _before the claim was filed_, that manoeuvre has to be committed
to on chain, in public, an hour ahead of an incident the holder must then
arrange to happen.

**The opposite abuse, and why it does not work either.** A holder could
declare an absurdly narrow mandate — `max_single_outflow = 1` — so that every
transfer breaches it. Three things bound that, and they are meant to ship
together: the payout is capped by the drop the chain _measured_, so a breach
with no loss pays nothing; `MIN_PROVABLE_MANDATE_BREACH` puts a floor under
what is worth an instruction at all; and Phase 9 makes the mandate an
underwriting input, so a mandate that makes ordinary operation a breach is
priced rather than free. Until Phase 9, this is the trigger's weakest edge and
the plan does not pretend otherwise.

Constants to add, with the reasoning that belongs next to each:

```rust
pub const AGENT_MANDATE_SEED: &[u8] = b"covantic_agent_mandate";
pub const AGENT_ERROR_EVIDENCE_SEED: &[u8] = b"covantic_agent_error_evidence";
pub const MANDATE_DECLARATION_DELAY: i64 = 3600;
pub const MAX_MANDATE_COUNTERPARTIES: usize = 8;
pub const MAX_MANDATE_PROGRAMS: usize = 8;
pub const MIN_PROVABLE_MANDATE_BREACH: u64 = 1_000_000; // 1 USDC
```

---

## 6. Phase 2 — Mandate reader and pure breach evaluator

`services/agent-error/mandate.ts` reads the PDA and applies the maturity rule,
mirroring `governance/checkpoint.ts:readBaseline` — including its subtlety:
the comparison off chain uses the claim row's `createdAt`, which is
necessarily _earlier_ than the `policy.claim_submitted_at` the program will
use, making the off-chain check strictly stricter. A mandate this accepts is
one the program will accept, never the reverse.

`services/agent-error/breach.ts` is pure and produces:

```ts
export interface MandateBreachReport {
  breached: boolean;
  /** Which dimensions were exceeded, each with the declared bound and the
   *  observed value. */
  dimensions: BreachDimension[];
  /** Quantitative overshoot in base units — the amount by which the outflow
   *  exceeded the declared cap. Zero for a purely categorical breach. */
  excessRaw: number;
  /** Checks that could not run. Never silently absent: an unevaluated
   *  counterparty check is a hole in the picture, not a pass. */
  unevaluated: string[];
}
```

Five dimensions, and the split between them is what §10's trust boundary
rests on:

| Dimension          | Kind         | Re-checkable on chain?                 |
| ------------------ | ------------ | -------------------------------------- |
| `single_outflow`   | quantitative | **yes** — against the measured drop    |
| `retained_balance` | quantitative | **yes** — against the current balance  |
| `window_outflow`   | quantitative | only with a Phase 3 outflow checkpoint |
| `counterparty`     | categorical  | no — the program cannot read a past tx |
| `program`          | categorical  | no — same                              |

---

## 7. Phase 3 — Outflow baseline

The "100x agent average" the product has advertised since launch, implemented
for the first time.

A new table `agent_outflow_stats`, written by the **existing exploit-watcher
crank** and by nothing else. The single-writer discipline is not incidental:
`baseline.ts` states it for balances — the off-chain screen and the on-chain
checkpoint must never disagree about what "before" meant — and the same
argument applies to flows.

Per agent, per rolling window: transfer count, summed outflow value, mean,
median, p95, and `observedFrom`. Staleness is explicit, following
`BASELINE_MAX_AGE_SEC`: past the bound, the ratio it supports reports as
**unevaluated**, never as absent and never as zero.

This baseline is a _detection_ input and a confidence input. It is deliberately
**not** a verdict input on its own: "this transfer is unusual for this agent"
is a reason to look, not a reason to pay. The mandate is what the verdict rests
on.

---

## 8. Phase 4 — Detection that actually fires

`services/agent-error/prefilter.ts`, replacing both current producers.

`screenForMandateBreach(tx, agentAddress, { mandate, outflowBaseline, pricer })`
flags on any of:

1. **Mandate-relative** — outflow value exceeds `max_single_outflow`, or takes
   the covered balance below `min_retained_balance`, or the destination is
   outside `allowed_counterparties`, or value routed through a program outside
   `allowed_programs`. Highest severity; this is the covered event.
2. **History-relative** — outflow ≥ `OUTFLOW_RATIO_THRESHOLD` × the agent's own
   p95, with a fresh baseline. This is the advertised rule, and it fires for
   agents with no mandate too — where it produces a monitoring event and a
   `review`, not a claim.
3. **Value-denominated size floor** — the current 1,000-unit rule, repaired:
   valued through the existing pricing stack (`oracle/valuation.ts`,
   `exploit/position.ts`) rather than summed across mints.

Detection **fails open**, as it does on the other three triggers: a mandate
that cannot be read, or a price that cannot be fetched, produces a flag with
an `unevaluated` marker, and the verifier decides. A screen that stayed silent
on a missing input would make the whole path depend on the pricing stack being
up.

`failed_tx` stays a monitoring event and becomes a risk-scorer input. If fee
burn is to be covered, it is covered as a declared window quantity
(`max_window_fee_burn` in the mandate) measured against real lamport spend —
not as a flat invented USDC amount per reverted transaction.

---

## 9. Phase 5 — Evidence bundle, pure adjudicator, replay

`AgentErrorEvidenceBundle` follows `ExploitEvidenceBundle` field for field
where it can, because the two share the position/loss/authorization spine:
`version`, `stage`, `triggerType: 3`, `txSignature`, `agentAddress`,
`holderAddress`, `coverageRaw`, `slot`, `blockTime`,
`blockTimeDisagreementSec`, `hasRawTx`, `position`, `loss`, `authorization`,
`prices`, `windows`, `collectedAt` (excluded from the hash — provenance, not
evidence). It adds `mandate` (the snapshot the verdict was measured against,
including `effective_at`), `breach` (the `MandateBreachReport`), and
`outflowBaseline`.

`adjudicateAgentError(bundle)` is pure — no I/O, no `Date.now()`, no
randomness — with `AGENT_ERROR_ADJUDICATOR_VERSION` and the same 0.92
`CONFIDENCE_CEILING`, below `AUTO_PAY_CONFIDENCE` (0.95), so off-chain
analysis can never release funds alone.

The decision, in order. The ordering is the design:

1. `!position || !authorization` → **indeterminate** `incomplete_evidence_bundle`.
2. `!hasRawTx` → **indeterminate** `no_chain_record`. Authorization is
   unanswerable from the indexer payload, and step 5 turns on it.
3. `!mandate` → **indeterminate** `no_mandate_declared` → review. _The absence
   of a declaration is a gap in our records, not the holder's consent._
4. `mandate.effectiveAt > claimSubmittedAt` → **indeterminate**
   `mandate_not_matured` → review. Never a rejection: a holder who declared
   late is not a holder who lied.
5. `!authorization.agentWasSigner` or a foreign transfer authority →
   **rejected** `not_agent_authorized`, with the trigger it belongs to named in
   the details. This is the complement of `adjudicateExploit`'s
   `agent_authorized_movement`, and the pair is what stops this trigger being
   the dumping ground.
6. `authorization.failed` → **rejected** `transaction_reverted_no_loss`.
7. `authorization.allDestinationsSelf` → **rejected** `self_transfer`. Money
   that came home was never lost, whatever route it took (this closes V5).
8. `!(loss.netLossUsd > 0)` → **rejected** `no_net_loss`.
9. `!breach.breached` → **rejected** `within_mandate`. **The false-positive
   killer.** The holder's own matured declaration says this movement was
   permitted; the vault does not insure a decision its owner authorised in
   advance.
10. Loss below `MIN_PAYABLE_LOSS_RAW` → **rejected** `loss_below_dust`.
11. Otherwise → **confirmed**, `reason: mandate_breach`, with
    `lossAmount` per §10.

Confidence is scored on how well established the _breach_ is, not on how large
the loss is: how many dimensions breached and agree, whether the baseline was
fresh, how much price confidence the valuation carried, and how many checks
came back `unevaluated`. Same lopsided budget as the exploit adjudicator, for
the same reason.

`scripts/claim-replay.ts:engineFor` gains `case TRIGGER_AGENT_ERROR`, and
`adjudicatorVersionFor` in the keeper stops returning `verifier-t3`.

---

## 10. Phase 6 — Trust-minimised settlement

`verify_and_payout_agent_error(payout_amount, evidence: { bundle_hash })`,
built on the same skeleton as `verify_and_payout_exploit`:

1. Not paused; caller is `config.oracle_authority`; policy is
   `STATE_CLAIM_PENDING`; `policy.trigger_type == TRIGGER_AGENT_ERROR`. This
   path proves a mandate breach and must not wave through a takeover or a bad
   fill.
2. `payout_amount <= policy.coverage_amount`; `LOCK_AGENT_ERROR` (6 h) elapsed
   since `claim_submitted_at`.
3. Mandate exists, belongs to this policy, and
   `mandate.effective_at <= policy.claim_submitted_at`, using `prev_*` when a
   refresh landed after the claim.
4. Baseline picked from `PolicyBalanceCheckpoint` with the exploit path's rule:
   the checkpoint if it predates `claim_submitted_at`, otherwise `prev_*`.
   Baseline must postdate `policy.start_time`.
5. **Measure the drop** from the covered ATA the program derives itself, never
   accepts from the caller.
6. **Re-check the cap.** `excess = observed_drop.saturating_sub(mandate.max_single_outflow)`,
   or, when the claim rests on the retained-balance dimension,
   `excess = mandate.min_retained_balance.saturating_sub(current_amount)`.
7. `require!(excess >= MIN_PROVABLE_MANDATE_BREACH)`.
8. `require!(payout_amount <= excess)`. There is no second, weaker bound —
   see below; the plan originally had one and it was wrong.
9. Write `AgentErrorEvidenceRecord` with `bundle_hash`, emit
   `AgentErrorProofVerified` alongside `ClaimPaid`.

### The payout is the overshoot, not the loss

Step 8 is the design decision worth arguing about explicitly, because it is
not obvious and it is not free.

A holder declares `max_single_outflow = 1,000`. The agent sends 50,000 to a
valid counterparty. Under this rule the vault pays 49,000, not 50,000: the
first 1,000 is the risk the holder declared they were willing to run, and the
protocol does not insure it.

That makes the mandate a **deductible the holder authors**, and it aligns the
two incentives that otherwise point in opposite directions. A wide mandate
means fewer breaches and a smaller payout when one happens; a narrow mandate
means more coverage and, in principle, a higher premium — though §16 explains
why pricing cannot see it. It also gives
the chain something arithmetically meaningful to bound the oracle with, which
`observed_drop` alone does not: a compromised oracle key pointed at a policy
whose agent merely spent money extracts nothing, because there is no overshoot
to extract.

### Categorical breaches do not settle here at all (changed from the plan)

The cost of bounding by the overshoot is that a categorical breach — right
size, wrong destination — has no overshoot. The plan proposed falling back to
`payout_amount <= observed_drop` for those, with a `categorical` flag recorded
on chain.

**That shipped differently, and the difference is the point.** The chain cannot
see a past transaction's destination, so such a payout would be the chain
releasing funds on the oracle's unverifiable word, bounded only by a drop that
says nothing about whether anything went wrong. And `categorical` would have
been an oracle-supplied boolean choosing which bound applied — discretion,
inside a proof path whose entire purpose is to remove it.

So the instruction settles only breaches it can measure. `breach_kind` records
_which_ of the two quantitative bounds was crossed — the outflow cap or the
retention floor — and both are re-derived on chain. A categorical-only breach
still confirms off chain and still reaches a human; `planProvenSettlement`
fails it closed as `breach_not_chain_checkable` rather than sending a
transaction that would revert, because the keeper marks a failed payout
`failed` rather than `review`.

The guarantee is unconditional as a result: _every proven agent-error payout is
bounded by an overshoot above a cap the holder signed for._ A narrower set of
claims settle automatically than the plan imagined, with a guarantee that has
no asterisk.

### The staleness trap, before anyone hits it

`verify_and_payout_exploit` bounds checkpoint age against `now`. **Copying that
here makes every agent-error payout unsatisfiable.** `LOCK_AGENT_ERROR` is
21,600 seconds; `MAX_CHECKPOINT_AGE` is 7,200. The lock alone is three times
the entire allowance, so `now - baseline_time <= MAX_CHECKPOINT_AGE` can never
hold at the moment the instruction becomes callable.

The governance path already hit this at a 2 h lock and fixed it by measuring
against `policy.claim_submitted_at` — which is also the question actually
worth asking: how stale was the reading when the incident happened, not how
long settlement subsequently took. This trigger inherits that fix, and the
CLAUDE.md invariant should be extended to name it, since agent error is the
case where the exploit path's version is not merely fragile but arithmetically
impossible.

### Wiring

- `settlement-plan.ts`: `{ kind: 'proven_mandate'; bundleHash }`, gated on
  `AGENT_ERROR_PROOF_ENABLED`, `unprovable` when the bundle hash is missing.
  Fail closed — a fallback to `legacy` would make the whole path decorative.
- `confidence-lanes.ts:hasProofPath` gains `TriggerType.AgentError`, at which
  point S3 stops being an accident.
- `claim-keeper.ts` gains an `AgentErrorProofPoster` alongside the other three.

### Deployment

This rides the **same pending redeploy** as the other three proof flags; see
the program-deploy runbook for the build flags and the keypair trap. One
asymmetry matters and is specific to this trigger:

- A missing _declaration_ resolves to `review` before any RPC, so enabling the
  flag early is harmless — the governance case.
- A missing _checkpoint_ makes the on-chain call revert, and the keeper marks
  the claim **`failed`, not `review`** — the exploit case.

Agent error depends on **both**, so it inherits the dangerous half. Do not set
`AGENT_ERROR_PROOF_ENABLED` unless the `exploit-watcher` crank is confirmed
running, or valid claims become failed ones.

---

## 11. Phase 7 — Trigger re-attribution

`adjudicateExploit` rejects with `agent_authorized_movement` exactly when this
trigger should confirm, and escalates `authorized_but_anomalous` exactly where
the two overlap. Today both outcomes close or park the claim, and the
agent-error question is never asked.

When the exploit adjudicator returns either reason **and** a matured mandate
exists for the policy, the keeper re-attributes the open claim to
`TriggerType.AgentError` and re-runs verification, instead of closing it.

Two constraints make this safe rather than a loophole:

- **Before on-chain submission only.** `oracle_submit_claim` writes
  `policy.trigger_type`; after that the trigger is fixed and re-attribution
  would require a new claim.
- **One direction only.** Exploit → agent error is a narrowing: it moves a
  claim from a path that pays the full unauthorised loss to one that pays only
  the declared overshoot. The reverse would let a mandate breach be re-filed as
  an exploit for a larger payout, and is not implemented.

This also repairs T4: the crossover is no longer a ranking assertion but a
code path with corpus cases behind it.

---

## 12. Phase 8 — Validation harness

`tests/fixtures/agent-error-corpus.ts` and `agent-error-corpus.test.ts`,
reusing the `TxSpec` builders from the exploit corpus. The same asymmetric
gate: **zero confirmations across the negatives is a hard CI failure**, while
recall across the positives is a tracked number with a floor.

Every negative below is a shape the _current_ verifier confirms or would
confirm. The list is a record of the specific ways a program-membership
heuristic gets this wrong, kept so the answers cannot quietly revert.

**Negatives — must never confirm**

1. Large swap through an allowed venue, inside the declared cap → `within_mandate`.
2. Bridge transfer to a declared counterparty → `within_mandate`. _(Today: confirmed at 0.5.)_
3. Transfer through an unrecognised program to a declared counterparty, inside the cap → `within_mandate`. _(Today: confirmed at 0.6 — the worst false positive in the file.)_
4. Reverted transaction, fee-only → `transaction_reverted_no_loss`. _(Today: confirmed at 0.6 on an invented 1 USDC.)_
5. Transfer between the agent's own token accounts → `self_transfer`.
6. Holder sweeping the treasury back to a wallet they control → `self_transfer`.
7. Drain by a foreign transfer authority → `not_agent_authorized` (Exploit).
8. Seizure via `SetAuthority` → `not_agent_authorized` (Governance).
9. 1,001 units of a worthless token → never reaches the verifier once T1 is fixed; asserted at the prefilter.
10. Mandate declared after the incident → `mandate_not_matured` → review.
11. No mandate at all → `no_mandate_declared` → review.
12. Breach with no net loss (over-cap transfer that returned in the same tx) → `no_net_loss`.

**Positives — must confirm, and at the right amount**

1. Fat-finger: 100× the declared single-tx cap to a valid counterparty. Assert `lossAmount == excess`, not the full transfer.
2. Runaway loop: repeated transfers blowing `max_window_outflow`.
3. Drain below `min_retained_balance`.
4. Correct size, undeclared counterparty — a categorical breach: confirms off chain, and `planProvenSettlement` must refuse it as `breach_not_chain_checkable`.
5. Value routed through an undeclared program.
6. Manifest-only breach (slippage bound in `manifest_hash`) — confirms below the ceiling and requires the chain bound to settle.

Plus the property tests the other three carry: replay determinism
(`adjudicateAgentError` twice over the same bundle is byte-identical), bundle
hash stability under key reordering, and `collectedAt` excluded from the hash.

---

## 13. Phase 9 — The holder's CLI

`pnpm mandate:declare --policy <id> --max-single 1000 --min-retained 500`,
mirroring `pnpm gov:declare`. Holder-signed for the same reason: an envelope
the operator could write would put the operator back in charge of the fact that
is supposed to constrain them.

Both declarations still need a UI.

The other half of the plan's Phase 9 — _the quote path reads the mandate and
prices it_ — could not be built. §16 says why, and what shipped instead.

---

## 14. Sequencing

| Order | Phase                             | Blocked by | Needs redeploy              |
| ----- | --------------------------------- | ---------- | --------------------------- |
| 1     | 0 — Stop the bleeding             | nothing    | no                          |
| 2     | 1 — Mandate on chain              | —          | yes (rides the pending one) |
| 3     | 2 — Reader + breach evaluator     | 1          | no                          |
| 4     | 3 — Outflow baseline              | —          | no                          |
| 5     | 4 — Detection                     | 2, 3       | no                          |
| 6     | 5 — Bundle + adjudicator + replay | 2          | no                          |
| 7     | 6 — Settlement                    | 1, 5       | yes                         |
| 8     | 7 — Re-attribution                | 5          | no                          |
| 9     | 8 — Corpus                        | 5          | no                          |
| 10    | 9 — Holder CLI                    | 1          | no                          |

Phases 3 and 4 are independent of the on-chain work and can proceed while the
redeploy is pending. Phase 8 should be written alongside Phase 5, not after it:
the corpus is how the adjudicator's decision order gets settled, and writing it
afterwards turns it into a description of whatever was built.

**Executed as sequenced, with two deviations,** both recorded in
§"Found while building": `large_transfer` had to be unmapped alongside
`failed_tx` in Phase 0 rather than left for later, and Phase 6 dropped the
categorical settlement branch the plan specified.

**What remains, in order:**

1. Redeploy the program. Phases 1 and 6 are built and tested but the deployed
   devnet program predates them, so `AGENT_ERROR_PROOF_ENABLED` stays false.
   It rides the same pending redeploy as the other three flags.
2. Confirm the `exploit-watcher` crank is running _before_ setting the flag.
   This trigger depends on a fresh balance checkpoint, and a missing one makes
   the payout revert — which the keeper records as `failed`, not `review`.
3. A UI for declaring a mandate. Until then, holders who never run
   `pnpm mandate:declare` have agent-error claims that resolve to review — the
   intended migration, not a bug.
4. Read §16 before designing the pricing work: the obvious approach does not
   work.

---

## 15. Honest summary of what this buys

**What becomes true.**

- The oracle can no longer choose the payout amount for this trigger. The
  program measures the drop from an account it derives itself, and pays at most
  the amount by which that drop exceeded a cap the holder signed for and which
  matured before the claim was filed.
- The verdict becomes reproducible. Before this change an agent-error payout
  had no evidence row, no bundle hash and no adjudicator version — it could not
  be audited even in principle. It now replays byte-identically, forever, and
  `pnpm claim:replay` knows how to dispatch it.
- The false-positive engine goes away. "Which programs appeared in this
  transaction" stops deciding anything; the holder's own pre-committed envelope
  decides instead.
- The trigger stops being a denial-of-coverage vector against the other three.

**What stays true, stated plainly.**

- **The chain still cannot see intent.** It sees a cap, a balance, and a
  subtraction. "The agent meant to do this" is answered by a declaration the
  holder made in advance, not by evidence about the moment itself.
- **Categorical breaches never settle automatically.** The program cannot read
  the destination or the program set of a past transaction, so a breach of only
  those dimensions confirms off chain and then goes to a human. That is a
  narrower automatic scope than the plan imagined, chosen so the guarantee has
  no asterisk.
- **A holder can still manufacture a claim, and the mitigation is partial.**
  Declare a plausible cap, make one deliberate over-cap payment to a third
  wallet you also control, and it looks exactly like the fat-finger this
  trigger exists to cover. §16 is honest about what catches the crude version,
  what does not catch the patient one, and what the real fix would cost.
- **The covered event is narrower than the marketing.** "Critical Agent Error"
  becomes "breach of a declared mandate". An agent that loses money inside its
  envelope is not covered. Every holder who wants coverage must declare a
  mandate and wait an hour for it to mature, exactly as the governance trigger
  requires a declaration today. Policies without one resolve to review — the
  intended migration, not a bug.
- **Detection recall is a measured number, not a promise.** The corpus holds
  breach _shapes_ rather than replays. That is now a statement about this
  path specifically, not about access: real mainnet transactions are replayed
  in `tests/incident-backtest.test.ts`, but without a declared mandate they
  all resolve to review here, so they measure the false-positive side and
  nothing about recall.

---

## 16. The one thing the plan got structurally wrong

The plan's Phase 9 was _"the quote path reads the mandate and folds its width
into the risk score"_, and it was the stated mitigation for the trigger's
weakest edge: a holder who declares an absurdly narrow envelope so that
ordinary operation breaches it.

**It cannot be built as described.** `PolicyAgentMandate` is a PDA seeded by
the _policy_, so it cannot exist before the policy does — and a quote is
issued before there is a policy to seed it from. There is nothing for the quote
path to read.

Worth being precise about how bad the underlying hole is, because it is the
sharpest remaining edge of this trigger. The self-transfer check knows only
about the holder and the agent, so a holder can send value to a **third wallet
they also control**, breach a cap they declared honestly an hour earlier, and
claim the overshoot. The maturity delay does not help: the declaration is
genuinely made in advance. The measured-drop bound does not help: the money
genuinely left.

**What shipped instead** is narrower, and it uses the outflow history Phase 3
built. `adjudicateAgentError` escalates — never rejects — when the declared cap
sits below the _median_ payment the agent has actually been making, because
more than half its ordinary operation would breach such an envelope. That is
either a claim generator or a holder deliberately restraining a misbehaving
agent, and nothing available to the adjudicator separates those two readings,
so it goes to a human.

That catches the crude version and not a patient one: a holder who declares a
plausible cap and then makes one deliberate over-cap payment to their own third
wallet looks exactly like a fat-finger, which is the covered event. The
remaining defences are the ones parametric insurance has always had — the
coverage limit, the premium, and the rolling payout breaker — plus the fact
that every declaration and every claim is public.

**The real fix, for whoever picks this up.** Seed the mandate by _agent
address_ rather than by policy, as `RiskAttestation` already is. A holder could
then declare before buying, the quote could price the envelope, and
`create_policy` could require a matured declaration for agent-error coverage.
It is a change to the account model — seeds, the reader, the poster, the CLI
and thirteen Anchor tests — and it should be made deliberately rather than
folded into this change set.
