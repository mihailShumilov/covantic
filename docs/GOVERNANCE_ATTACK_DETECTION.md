# Governance Attack Detection — Hardening Plan

Scope: `TriggerType.GovernanceAttack` (4) — detection, verification, and
settlement. Third in the series after
[`ORACLE_MANIPULATION_DETECTION.md`](./ORACLE_MANIPULATION_DETECTION.md) and
[`EXPLOIT_DETECTION.md`](./EXPLOIT_DETECTION.md). It reuses their evidence
spine wherever it fits and says explicitly where a takeover needs something
neither of them has.

---

## Implementation status

All nine phases are implemented, plus the four immediate fixes in §14. 368 API
tests pass; `tsc --noEmit` and `eslint src` are clean; `cargo check` is clean
and `anchor build` produces both the program binary and the IDL. 43 Anchor
integration tests pass, including sixteen written for this trigger.

| Phase | State | Where |
|-------|-------|-------|
| 1 — Governance baseline (holder-declared authority manifest) | done | `anchor/.../{state/governance_baseline.rs,instructions/declare_governance_baseline.rs}`, `api/scripts/declare-governance-baseline.ts` |
| 2 — Authority checkpoint (permissionless crank) | done | `anchor/.../{state/authority_checkpoint.rs,instructions/checkpoint_authority.rs}`, `services/governance/checkpoint.ts` |
| 3 — Authority forensics | done | `services/governance/authority.ts` |
| 4 — The conjunction: takeover → drain | done | `services/governance/conjunction.ts` |
| 5 — Governance signatures | done | `services/governance/signatures.ts` |
| 6 — Evidence bundle, pure adjudicator, replay | done | `services/governance/{types,adjudicate}.ts`, `scripts/claim-replay.ts` |
| 7 — Detection that fires | done | `services/governance/prefilter.ts`, `workers/exploit-watcher.ts` |
| 8 — Trust-minimised settlement | code done, **not deployed** | `anchor/.../instructions/verify_and_payout_governance.rs`, `services/governance/proof-poster.ts` |
| 9 — Validation harness | done | `tests/fixtures/governance-corpus.ts`, `tests/governance-corpus.test.ts` |

**Corpus result:** 5/5 takeover shapes confirmed (recall 1.0 against a 0.8
floor), 0/14 operational shapes confirmed, and each of the fourteen fails for
a *different* reason — the corpus is measuring the logic, not one blanket
refusal. Confirmations land at 0.82–0.87 confidence, under the 0.92
adjudicator ceiling and therefore under the 0.95 auto-pay bar, so every one
still requires the chain's own reading.

**Carried forward, with the reason:**

- *Phase 8 deployment.* `GOVERNANCE_PROOF_ENABLED` stays false until the
  program is redeployed by hand. Deployment is manual on this project; do not
  run `anchor keys sync`.
- *No holder-facing UI.* Declaring a baseline is a CLI today
  (`pnpm gov:declare`). Until a policy declares one, its governance claims
  resolve to review — correct, but it means the mechanism is opt-in per
  policy and nothing prompts the holder to opt in.
- *No webhook-path detection.* Governance is detected by the pull path only,
  bounded by the sweep interval rather than by webhook delivery. The reasoning
  is recorded at the top of `services/governance/prefilter.ts`; the short
  version is that nothing this screen needs exists in the indexer payload, and
  both ways of faking it are worse than the latency.
- *Squads configs are undecodable.* A multisig threshold change reports
  `unevaluated`, never absent — and when the policy declares a controller, it
  escalates rather than closing. Decoding Squads would need a maintained
  binary decoder, which this codebase deliberately has none of.
- *Real-incident replay.* The corpus holds takeover *shapes*, not mainnet
  replays; archival RPC access is not available in this environment.

---

## Found while building

Two things the implementation surfaced that the plan did not predict. Both
changed the design.

### The exploit proof path cannot settle a seizure

`verify_and_payout_exploit` and `checkpoint_balance` both derive the covered
account with:

```rust
#[account(
    associated_token::mint = usdc_mint,
    associated_token::authority = policy.agent_address,
)]
```

Anchor compiles the `authority` half into an owner equality check on the token
account (`anchor-syn`'s associated-token codegen: `let my_owner = account.owner
… if my_owner != wallet_address { ConstraintTokenOwner }`). So the moment a
`SetAuthority(AccountOwner)` lands, the instruction can no longer load the
account at all — and the balance never dropped anyway, so there would be
nothing to measure even if it could.

This is not a small gap. It means a seizure was *detected* by the exploit
screen (`control_change`, critical) and then routed to a settlement path
structurally incapable of closing it. The governance instructions therefore
derive the covered account **by address** — `address =
get_associated_token_address(&policy.agent_address, &usdc_mint.key())` — which
keeps the caller from choosing the account while allowing the owner to have
changed. That is exactly the state being observed.

`anchor/tests/covantic.test.ts` pins the finding: *"cannot settle a seizure —
the covered account stops being the agent's"*.

### Checkpoint staleness measured against `now` is unsatisfiable here

The exploit path bounds its checkpoint with `now - baseline_time <=
MAX_CHECKPOINT_AGE`, which silently folds its one-hour lock into a two-hour
allowance. That leaves an hour of slack and works.

Governance's lock is two hours — the entire allowance — so the same comparison
would have made *every* governance payout fail, including on evidence that was
perfect. The Anchor test caught it on the first run.

`verify_and_payout_governance` measures staleness against
`policy.claim_submitted_at` instead, which is also the question actually worth
asking: how stale was the reading when the incident happened, not how long
settlement subsequently took. **The same latent fragility exists on the
exploit path** — it is not currently a bug there, and it was left alone rather
than changed under a governance heading.

---

## 0. What "100% proof" can actually mean here

The same split as the two companion plans, with one difference that runs
through everything below and is the reason this trigger is worth doing
properly rather than deleting.

**Not reachable: 100% detection recall.** "Was this a governance attack?" is
an open-world judgement against an adversary who reads this repository. Any
fixed rule set can be walked around. Recall is a *measured, CI-gated number*
against a labelled corpus (§11), not a promise.

**Reachable, and strictly more than the other two triggers reach.** This is
the point worth stating up front, because it inverts the intuition that
governance is the vaguest of the four triggers:

| Trigger | What the chain can establish for itself |
|---------|------------------------------------------|
| Oracle manipulation | A guardian-signed *price*. The historical swap it is being compared against stays an off-chain assertion. |
| Exploit | A balance *drop*, by subtraction between two readings it took. Why the money left stays an off-chain assertion. |
| **Governance attack** | **The covered event itself.** Who controls an account is not a transient event and not an off-chain number — it is persistent on-chain state that the program can read directly, before and after, and compare against a set the *holder signed in advance*. |

So the guarantees available here are:

| # | Guarantee | Meaning for a governance claim |
|---|-----------|--------------------------------|
| **G1** | **Soundness on the auto-pay lane** | `verify_and_payout_governance` reads the covered account's current authority set, compares it to a checkpoint the program wrote earlier and to a baseline the holder declared and signed before the incident, and refuses to pay unless control actually left that set. The oracle does not assert the takeover; the program observes it. |
| **G2** | **Reproducibility** | The verdict is a pure function of an immutable evidence bundle. `sha256(bundle)` is committed on chain. Anyone replaying the bundle gets a byte-identical verdict, forever. |
| **G3** | **No silent failure** | Every claim ends in exactly one of `paid`, `rejected(reason)`, `indeterminate→review`. A claim is never rejected because an RPC timed out, a Squads config could not be decoded, or no baseline had been declared. |

**The honest boundary, stated once.** The chain can prove that control left
the declared set and that the new authority is neither the holder nor the
agent. It cannot prove that the new authority is not a *Sybil* of the holder —
a second wallet they also control. That residual is the same one the exploit
path carries with destination control, and it is bounded the same way: the
committed bundle, the two-hour lock, and the payout circuit breaker.

Governance has one constraint the exploit path does not, and it is worth the
implementation cost on its own: **the holder pre-commits.** A fraudulent
governance claim requires the holder to have signed a manifest an hour before
the incident, left it on chain, and then departed from it. That is a
materially harder lie to tell than "I moved my own money and called it a
drain", and it is permanently falsifiable afterwards.

---

## 1. Current state

```
detect:  nothing.  The only producer of a `governance_attack` alert in the
         entire codebase is POST /api/demo/simulate-exploit, gated by
         NODE_ENV.
verify:  services/verifiers/governance-attack.ts — 120 lines, EnhancedTransaction
         only, no chain read, no evidence bundle.
settle:  planProvenSettlement() → { kind: 'legacy' }.
         hasProofPath(4) → false.
```

The product sells this coverage. In production it cannot fire, and if it did,
the verifier would answer the wrong question.

---

## 2. Defect inventory

### Detection

- **D1 — nothing emits it.** `TransactionMonitor.detectAnomalies` screens four
  things: `large_transfer`, `failed_tx`, `exploit`, `oracle_deviation`. The
  `exploit-watcher` raises `exploit` and `balance_drop_unexplained`. No path
  produces `governance_attack`. An insured agent can have its accounts seized
  and no claim will ever open.

- **D2 — the enum and the map do not agree.** `MonitoringEventType.GovernanceChange`
  is `'governance_change'`; the key the claim-keeper maps is `'governance_attack'`.
  Wiring the enum value up would produce alerts the keeper silently drops
  (`EVENT_TO_TRIGGER[eventType] === undefined` → debug log → return). This is
  a live trap for whoever implements D1.

- **D3 — lowest specificity by omission.** `ANOMALY_SPECIFICITY` has no
  governance entry, so `specificity()` returns 0 — below `large_transfer`. A
  policy holds one open claim (`claims_open_unique`), so a takeover that also
  moves a large amount would be filed as **AgentError**, routing the incident
  to a verifier with nothing to say about who owns the account now.

### Verification correctness

- **D4 — it asks the wrong question.** The decisive branch is
  `if (!programs.governance) → rejected`, where `governance` means "SPL
  Governance or Metadao appeared in the transaction". But the covered subject
  is an *agent wallet*, not a DAO. A takeover of an agent is a `SetAuthority`,
  `Approve`, `FreezeAccount`, a BPF Loader Upgradeable authority change, or a
  Squads config change — none of which touches either program in
  `GOVERNANCE_PROGRAM_IDS`. The verifier therefore rejects essentially every
  real shape with `no_governance_program`.

- **D5 — and it is a false-positive engine in the other direction.** When a
  governance program *is* present, the only further test is "some account
  moved more than 0.01 SOL, or any token balance changed at all". A routine
  Realms vote in a transaction that also pays rent confirms at 0.55 confidence
  for 50% of coverage.

- **D6 — the loss is fabricated.** `DEFAULT_GOVERNANCE_PAYOUT_RATIO = 0.5`
  pays half the coverage regardless of what was actually lost. It is not a
  measurement of anything, and it is what lands in `claims.payoutAmount` and
  would be handed to `verify_and_payout`, the instruction that trusts the
  number.

- **D7 — it violates the three-valued invariant.** The verifier never returns
  `indeterminate`. Both of its negative branches are *rejections* derived from
  the Helius indexer payload alone — the payload that, per `CLAUDE.md`, cannot
  answer authorization. A thin or lagging payload closes a valid claim, which
  is precisely the failure the three-valued rule exists to prevent.

- **D8 — no chain read.** The verifier signature takes `EnhancedTransaction`
  and nothing else. It cannot see signer flags, and it cannot see
  `preTokenBalances[i].owner` against its post counterpart — which is exactly
  where an account seizure is visible, because in a seizure the balance never
  moves, the owner does.

- **D9 — not replayable.** No evidence bundle is produced, so
  `claim-replay`'s `engineFor()` returns `null` for `triggerType: 4` and every
  governance claim reports `not_replayable`. G2 is false for this trigger
  today.

- **D10 — the conjunction is never computed.** The coverage table promises
  "admin key change + drain within 30m". Nothing in the codebase measures a
  window, correlates a takeover with an outflow, or values one.

### Settlement trust

- **D11 — no proof path, therefore permanent review.** `planProvenSettlement`
  returns `legacy`, `hasProofPath(4)` is false, and the verifier's ceiling is
  0.55 — below `REVIEW_CONFIDENCE` (0.75). Every real governance claim goes to
  a human. That is the correct fail-safe direction, but it also means the
  trigger is decorative: it cannot pay, and it can still wrongly *close* a
  claim via D7.

- **D12 — one constant from an unbounded payout.** If a future change lifted
  confidence to ≥ 0.95, `decideLane` returns `{ lane: 'pay', requiresChainProof: false }`
  and settlement falls through to `verify_and_payout` — the legacy instruction
  with no bound on the amount beyond coverage. The only thing preventing that
  today is a number in a verifier.

- **D13 — the demo path is the only way it pays.** `syntheticVerification`
  returns confidence 1.0 and 80% of coverage for trigger 4, which clears the
  auto-pay bar and settles through the legacy instruction. It is gated by
  `syntheticAllowed()` (three independent conditions), so this is not a live
  hole — but it does mean the only governance payout the system has ever
  executed was one that looked at nothing.

### Definition

- **D14 — no on-chain notion of legitimate control.** Without a declared
  baseline, "the authority changed" cannot be distinguished from "the holder
  rotated keys" by any amount of forensics. This is the gap Phase 1 exists to
  close, and every other phase depends on it.

---

## 3. Target architecture

Mirrors the exploit spine, and reuses it wherever the shapes coincide.

```
detection
  services/governance/prefilter.ts          screen a RawTxView for authority departure
  services/governance/authority-baseline.ts off-chain snapshot of the authority set
  workers/exploit-watcher.ts                third job on the existing tick
  transaction-monitor.ts                    webhook-path screen

evidence
  services/governance/authority.ts          facts: who controlled what, before and after
  services/governance/conjunction.ts        takeover → drain correlation and valuation
  services/governance/signatures.ts         weighted structural evidence
  services/governance/types.ts              GovernanceEvidenceBundle
  services/governance/adjudicate.ts         PURE — no I/O, no clock, no randomness

settlement
  anchor state/governance_baseline.rs       holder-signed manifest of legitimate control
  anchor state/authority_checkpoint.rs      program-read authority snapshot (+ prev_*)
  anchor state/governance_evidence.rs       immutable record of what was measured
  anchor instructions/declare_governance_baseline.rs   holder-signed, matures on a delay
  anchor instructions/checkpoint_authority.rs          permissionless crank
  anchor instructions/verify_and_payout_governance.rs  oracle-called, program-bounded
  services/governance/{checkpoint,proof-poster}.ts
```

Reused unchanged, deliberately:

- `exploit/raw-tx.ts` — the `RawTxView`. The RPC's `jsonParsed` encoding
  already decodes `setAuthority`, `approve`, `freezeAccount` and the system
  program, which is why this plan does not hand-roll a binary decoder that
  would need maintaining against Token-2022.
- `exploit/loss.ts` and `exploit/position.ts` — a governance loss is priced
  identically to an exploit loss. A second valuation path would be a second
  place for the two to disagree.
- `PolicyBalanceCheckpoint` — the drain half of a takeover is measured against
  the same on-chain checkpoint the exploit path uses. One writer, one meaning
  of "before".
- `exploit/signatures.ts`'s `CohortLookup` — "who else was taken over by this
  same new authority" is the same query as "who else was drained to this same
  counterparty".

---

## 4. Phase 1 — Define the covered event on chain

`declare_governance_baseline(manifest)` — **holder-signed**, one PDA per
policy, seeds `[GOVERNANCE_BASELINE_SEED, policy.key()]`.

```rust
pub struct GovernanceBaseline {
    pub policy_id: u64,
    pub holder: Pubkey,

    /// Expected owner of the covered ATA. Normally the agent.
    pub token_owner: Pubkey,
    /// Expected delegate. `None` for an agent that never delegates.
    pub expected_delegate: Option<Pubkey>,
    pub expected_close_authority: Option<Pubkey>,
    /// Upgrade authority of the agent's own program, when it runs one.
    pub program_upgrade_authority: Option<Pubkey>,
    /// Squads / multisig config account and the threshold it must not fall below.
    pub controller: Option<Pubkey>,
    pub controller_min_threshold: u16,

    /// sha256 of the off-chain manifest covering anything richer than the
    /// fixed fields above — an allowed-signer set, a rotation policy.
    /// Committed, not interpreted: the chain checks what it can read and
    /// leaves the rest publicly falsifiable.
    pub manifest_hash: [u8; 32],

    /// When this baseline becomes usable as proof.
    pub effective_at: i64,
    /// The manifest this one replaced, retained for the same reason
    /// `PolicyBalanceCheckpoint.prev_*` is.
    pub prev_token_owner: Pubkey,
    pub prev_effective_at: i64,
    pub bump: u8,
}
```

Two properties carry the weight:

**Maturity.** `effective_at = now + GOVERNANCE_BASELINE_DELAY` (1 hour). A
baseline is not usable to prove a claim until it matures, and an *update* is
subject to the same delay while the previous manifest is retained. Without
this, a compromised holder key could declare a fresh baseline and immediately
claim against it; with it, the same attacker must pre-commit an hour early and
leave the commitment on chain.

**Retention.** A rotation landing between the takeover and the claim must not
erase the only pre-incident truth. `prev_*` is the same mechanism, for the
same reason, as on the balance checkpoint.

**Rejected alternative, recorded so it is not rediscovered:** infer the
baseline from the first authority checkpoint. It works mechanically, and it
is strictly worse — it makes the *protocol* guess what the holder intended,
which is the guess this whole phase exists to replace with a signature.
Policies created before this ships have no baseline and must resolve to
`indeterminate → review`, never to a rejection (see §9).

---

## 5. Phase 2 — Authority checkpoint

`checkpoint_authority()` — **permissionless**, for the same reason
`checkpoint_balance` is: a baseline only the oracle could write would put the
oracle back in charge of the number that is supposed to constrain it.

It reads, from accounts Anchor **derives rather than accepts** —
`associated_token::mint = usdc_mint, associated_token::authority = policy.agent_address`,
exactly as the balance crank does:

| Field | Source | Why it matters |
|-------|--------|----------------|
| `owner` | covered ATA | A `SetAuthority(AccountOwner)` seizure moves this and nothing else. |
| `delegate`, `delegated_amount` | covered ATA | An allowance granted now, pulled later. |
| `close_authority` | covered ATA | Lets a third party close the account and take the rent — and forces recreation. |
| `frozen` | covered ATA `state` | **The shape the balance path is blind to.** A frozen account never drops; the agent simply can no longer move it. |
| `upgrade_authority` | `program_data`, when the baseline declared one | Seizing the agent's program is a takeover of everything the program controls. |

Same `prev_*` retention, same `MAX_CHECKPOINT_AGE` bound.

**Run it on the existing `exploit-watcher` tick, in the same loop as
`checkpoint_balance`.** One writer, so "authority before" and "balance before"
name the same instant. Two cranks on two schedules would eventually disagree,
and the conjunction check in §7 is exactly the thing that disagreement would
corrupt.

---

## 6. Phase 3 — Authority forensics

`services/governance/authority.ts`, built on the existing `RawTxView`. Facts,
not judgements — weighing is §8's job and deciding is the adjudicator's.

```ts
interface Takeover {
  account: string;
  kind: 'owner' | 'close' | 'freeze' | 'delegate' | 'upgrade' | 'multisig_config';
  previousAuthority: string | null;
  newAuthority: string | null;
  signer: string | null;
  signerIsAgent: boolean;
  signerIsHolder: boolean;
  signerInManifest: boolean | null;   // null = manifest not available
  viaCpi: boolean;
}
```

Extend `exploit/authorization.ts` rather than duplicating it: it already
decodes `setAuthority` and `closeAccount` into `ControlChange`. What it needs
is `freezeAccount`, promotion of `approve` into the same shape, and the BPF
Loader Upgradeable `SetAuthority`.

Reuse its `isSelf()` resolution wholesale for `newAuthorityIsSelf` — a
destination is self when it is the holder wallet, the agent wallet, or a token
account owned by either. This is the check that rejects a holder rotating keys
to their own second wallet.

`GOVERNANCE_PROGRAM_IDS` widens into a *governance surface* set — BPF Loader
Upgradeable, Squads v4, SPL Governance, Metadao — but it stays what it is in
the exploit path: **an audit-trail field, never a verdict input.** The lesson
is already written into `CLAUDE.md` for exploits and applies verbatim here:
program membership decides nothing.

**Unevaluated, never absent.** A Squads config change is not `jsonParsed`;
until a decoder exists it must report `present: null` with a reason, and the
confidence score is docked for it. Pretending to have checked is worse than
admitting we did not.

---

## 7. Phase 4 — The conjunction

The trigger's actual definition, and the thing nothing computes today.

`services/governance/conjunction.ts` takes the takeover's block time and the
agent's balance history (`agentBalanceSnapshots` plus `readAgentBalances`) and
finds what happened inside `GOVERNANCE_DRAIN_WINDOW`, valued with
`exploit/loss.ts`.

Two shapes, both covered, and they must be told apart because they are bounded
by different numbers:

**Takeover-then-drain.** Value left. The loss is the drop, measured exactly as
the exploit path measures it, against the same `PolicyBalanceCheckpoint`.

**Seizure or freeze.** Value did not move; control did. The balance path
measures zero and the exploit adjudicator would reject it as `no_net_loss`.
The loss is the value now sitting under foreign control — which the program
can read directly, because it is the current balance of an account whose owner
is no longer the agent. **This shape is the reason governance needs its own
settlement instruction rather than borrowing the exploit one.**

On the 30-minute window: it is a marketing number, and a patient attacker
waits thirty-one minutes. The recommendation is to let the window bound the
*proof* path only — a tight, provable conjunction that can pay automatically —
while a takeover whose drain lands later still routes to review rather than
being denied. That distinction belongs in the coverage table, stated, rather
than being quietly widened.

---

## 8. Phase 5 — Governance signatures

`services/governance/signatures.ts`, same discipline as the exploit module:
`present: boolean | null`, `unevaluated` never conflated with `false`, weights
tuned so no single corroborating signal can carry a verdict alone.

| id | weight | what it establishes |
|----|--------|---------------------|
| `authority_left_manifest` | 0.45 | Control sits outside the holder's matured, declared set. The load-bearing one. |
| `takeover_signer_foreign` | 0.40 | Whoever signed the change is neither agent, holder, nor a manifest signer. |
| `account_frozen` | 0.30 | Covered account frozen by a foreign freeze authority. |
| `upgrade_authority_seized` | 0.30 | The agent's program upgrade authority moved. |
| `drain_follows_takeover` | 0.30 | Material outflow inside the window, after the change. |
| `victim_cohort` | 0.30 | Another insured agent taken over by the same new authority in the window. |
| `multisig_threshold_lowered` | 0.25 | Squads config weakened. Reports `null` until a decoder exists. |
| `delegate_installed_then_pulled` | 0.25 | `approve` followed by a foreign-authority transfer. |
| `new_authority_first_seen` | 0.20 | The new authority has no history before the incident. |

**Authorization class** — at least one must fire before any pay lane is
reachable: `authority_left_manifest`, `takeover_signer_foreign`,
`account_frozen`, `upgrade_authority_seized`.

Note what is *not* on this list: "a governance program was invoked". It was the
whole of the old verifier and it establishes nothing.

---

## 9. Phase 6 — Evidence bundle, pure adjudicator, replay

`GovernanceEvidenceBundle` carries `triggerType: 4` so a replay dispatches
without consulting the claim row, `version`, `stage`, `hasRawTx`, the baseline
as read from chain, the authority readings before and after, `takeovers`,
`conjunction`, `loss`, `signatures`, `prices`, `windows`, and a `collectedAt`
that is **excluded from the hash** — provenance, not evidence.

`adjudicateGovernance(bundle)` is pure: no I/O, no `Date.now()`, no randomness.
`GOVERNANCE_ADJUDICATOR_VERSION` gets bumped rather than edited quietly.
Confidence ceiling **0.92**, below `AUTO_PAY_CONFIDENCE` (0.95), for exactly
the reason the other two have it: off-chain analysis must never be able to
release funds on its own. That gap is the guarantee.

The decision shape, stated plainly because it is not the one the current
verifier makes:

| Condition | Outcome | Why |
|-----------|---------|-----|
| No matured baseline for the policy | `indeterminate` → review | The absence of a declaration is our gap, not evidence the holder consented. Every pre-existing policy lands here. |
| No raw transaction available | `indeterminate` | Authorization is unanswerable from the indexer payload, and it is what the verdict rests on. |
| Authority matches the matured baseline | **`rejected`** | The one clean rejection, and it rests on a positive on-chain fact rather than an absence. |
| New authority resolves to holder or agent | `rejected` (`self_rotation`) | Control that stayed in the family was never taken. |
| Left the baseline, foreign signer, loss in window | `confirmed` | The covered event, observed. |
| Left the baseline but the holder or agent signed it | `indeterminate` (`authorized_rotation_anomalous`) when corroboration clears the bar | A stolen holder key signs exactly like the holder. This module does not pretend to separate those two, and escalates rather than paying or denying. |

Then add `TRIGGER_GOVERNANCE_ATTACK` to `claim-replay`'s `engineFor()`.
Without that line, G2 is false for this trigger no matter what else ships.

---

## 10. Phase 7 — Detection that actually fires

**`services/governance/prefilter.ts`** — `screenRawTxForGovernance(view, agentAddress, { baseline })`.
Flags any `setAuthority` / `freezeAccount` / `approve` touching an account the
agent owns, or a loader `SetAuthority` on the agent's program, where the
resulting authority sits outside the baseline. Cheap, structural, and it
**fails open** — a screen that is unsure raises.

Wire it into both paths, for the reason already established for exploits:

- **Webhook path** — `TransactionMonitor.detectAnomalies`. Fast and fragile.
- **Pull path** — `exploit-watcher.sweepTransactions`, which already fetches
  the `RawTxView` per transaction, so this is nearly free and is the *stronger*
  of the two.

**Third job on the watcher tick:** diff this tick's authority checkpoint
against the previous one. An authority change with no transaction the screen
could attribute to it raises `governance_change_unexplained`, which is
**deliberately unmapped** in `EVENT_TO_TRIGGER` — straight to a human, exactly
like `balance_drop_unexplained`, and for the same reason. There is nothing for
a verifier to verify.

**Fix D2 structurally, not by renaming.** Emit the literal `governance_attack`,
make `MonitoringEventType` carry that value, and add a unit test asserting
every `MonitoringEventType` value is a *key* in `EVENT_TO_TRIGGER` — including
the intentionally-`undefined` ones. That test is what stops this class of bug
coming back; a rename alone does not.

**Fix D3:** `ANOMALY_SPECIFICITY.governance_attack = 5`, above `exploit: 4`.
A takeover that also drains is a takeover. Filing it as an exploit routes it to
a verifier that can measure the drop but has nothing to say about who owns the
account now — and the seizure-without-drain shape would be rejected outright as
`no_net_loss`.

---

## 11. Phase 8 — Trust-minimised settlement

`verify_and_payout_governance(payout_amount, evidence: { bundle_hash })`.

What the program checks **for itself**, in order:

1. `policy.trigger_type == TRIGGER_GOVERNANCE_ATTACK`. This path proves a
   takeover; it must not wave through a bad fill or a plain drain.
2. `now >= policy.claim_submitted_at + LOCK_GOVERNANCE_ATTACK` (7200s, already
   defined).
3. The baseline PDA belongs to this policy and
   `effective_at <= policy.claim_submitted_at` — it matured before the
   incident.
4. Re-reads the covered ATA **now**, derived by `associated_token` constraints,
   for `owner`, `delegate`, `close_authority`, `state`.
5. Reads the authority checkpoint, selecting the pre-claim reading with the
   same `prev_*` rule and the same `MAX_CHECKPOINT_AGE` bound as the balance
   path.
6. **Requires a real departure**: the observed authority is outside the
   declared set, and the new authority is neither `policy.holder` nor
   `policy.agent_address`. This is the covered event, proven rather than
   asserted.
7. **Bounds the payout**, and this is where the two shapes diverge:
   - drain: `payout ≤ observed_drop` from `PolicyBalanceCheckpoint` — the same
     subtraction the exploit path performs, against the same account.
   - seizure: `payout ≤ current_amount` — the value now under foreign control,
     read directly.
   - **`payout ≤ max(observed_drop, current_amount)`, never the sum.**
     Double-counting the same dollars is the obvious bug in this instruction
     and it must be impossible by construction rather than by care.
8. Writes `GovernanceEvidenceRecord` with `init` (not `init_if_needed` — one
   policy, one proven payout, and a second attempt should fail loudly), and
   emits `GovernanceProofVerified` so an indexer can tell a payout the chain
   checked from one it merely permitted.

New errors: `GovernanceBaselineMissing`, `GovernanceBaselineNotMatured`,
`AuthorityWithinBaseline`, `PayoutExceedsSeizedValue`.
New constants: `GOVERNANCE_BASELINE_SEED`, `AUTHORITY_CHECKPOINT_SEED`,
`GOVERNANCE_EVIDENCE_SEED`, `GOVERNANCE_BASELINE_DELAY`,
`GOVERNANCE_DRAIN_WINDOW`, `MIN_PROVABLE_SEIZED_RAW`.

Backend wiring: `planProvenSettlement` gains
`{ kind: 'proven_authority'; bundleHash }` gated on `GOVERNANCE_PROOF_ENABLED`
(default false, same as its two siblings), and `hasProofPath()` gains trigger
4. The `unprovable` branch already fails closed and needs no change — which is
the property that makes the whole path non-decorative: an attacker who can
stop a proof from being built gets review, not the legacy behaviour.

**Run `anchor build --no-idl` on this instruction specifically.** It reads two
checkpoints, a baseline, a token account and a mint; `cargo check` will not
catch the BPF stack-frame overflow that shape produces in `try_accounts`. Box
the account structs when it complains.

---

## 12. Phase 9 — Validation harness

`tests/fixtures/governance-corpus.ts` + `tests/governance-corpus.test.ts`, with
the same asymmetric gate as the exploit corpus: **any confirmation on a
negative fails the build, with no allowance**; recall on the positives is a
floor (0.8), because the honest response to an ambiguous case is review.

**Positives** — owner seizure via `SetAuthority`; delegate installed then
pulled; freeze-and-ransom (no balance movement at all); upgrade authority
seized then the program drains; multisig threshold lowered then drain; takeover
whose drain is laundered through a DEX; one new authority taking over two
insured agents in the same window.

**Negatives** — the half that matters, and every one is a shape the *current*
verifier confirms or would:

- a routine Realms vote in a transaction that also moves rent — confirmed
  today at 50% of coverage;
- the holder rotating the agent key to a wallet inside the declared manifest;
- the agent granting a delegate to a lending protocol and repaying it;
- `closeAccount` sweeping dust back to the holder;
- a Squads config change that *raises* the threshold;
- a program upgrade performed by the declared upgrade authority;
- an ATA closed and recreated during a mint migration.

Plus one Anchor integration test per on-chain guard: baseline not matured,
authority within baseline, checkpoint too old, checkpoint written after the
claim, payout above the observed drop, payout above the seized value, wrong
trigger type, double settlement. The exploit path already carries eleven of
these in `anchor/tests/covantic.test.ts`; the pattern is established.

---

## 13. Sequencing (as executed)

The order is not the phase order, and the reason is that thresholds tuned
against fixtures are worth less than thresholds tuned against traffic.

1. **Phase 7 detection, with no pay lane.** Raise `governance_attack` to review
   only. The trigger is invisible today; making it visible costs nothing and
   immediately produces the traffic every threshold below should be tuned
   against. Fix D2 and D3 in the same change, with the enum/map test.
2. **Phases 3 and 6** — forensics, bundle, pure adjudicator, replay
   registration. Claims become explainable and reproducible while still
   routing to review.
3. **Phases 1 and 2** — baseline and authority checkpoint. Needs a program
   redeploy: do it by hand, and do not run `anchor keys sync`.
4. **Phases 4 and 5** — conjunction and signatures, tuned against what step 1
   produced.
5. **Phase 8** — settlement, with `GOVERNANCE_PROOF_ENABLED=false`.
6. **Phase 9** — corpus gate green, Anchor tests passing, then flip the flag.

Steps 1–2 are the ones that stop valid claims being wrongly closed (D7), and
they ship without touching the program. Everything after that is about being
able to *pay* one.

---

## 14. Immediate actions (done)

The four changes that removed a live defect without needing a redeploy. Kept
here as a record of what they were and what they cost.

1. **The verifier no longer closes claims on absent evidence.** Both
   indexer-derived rejections became `indeterminate`. The one rejection that
   survives is a reverted transaction, which is a fact about the chain's
   record rather than an absence.
2. **`DEFAULT_GOVERNANCE_PAYOUT_RATIO` is gone.** It paid half the coverage
   regardless of what happened. Nothing produces a payable amount now until
   the loss is measured.
3. **The enum and the map are one contract.** `MonitoringEventType` became the
   real vocabulary (it declared `governance_change` while the keeper mapped
   `governance_attack`), `EVENT_TO_TRIGGER` moved to
   `services/event-vocabulary.ts` typed as `Record<MonitoringEventType, …>` so
   a missing member is a compile error, and every producer switched from
   string literals to enum members. `tests/monitoring-vocabulary.test.ts`
   covers the runtime half.
4. **`governance_attack: 5`**, above `exploit: 4`, in a specificity table that
   is now total over the enum — an absent rank silently became zero, which is
   how a takeover would have been filed as an AgentError.

---

## 15. Honest summary of what this buys

- **G1 is stronger here than on either companion path.** The chain proves the
  covered event itself — control left the set the holder signed — rather than
  merely bounding its magnitude.
- **The residual is a Sybil.** The new authority could be a second wallet the
  holder controls. Bounded by the committed bundle, the two-hour lock, the
  circuit breaker, and by the fact that the holder had to pre-commit to a
  manifest an hour before the incident and leave it on chain.
- **Not bought: recall.** An adaptive adversary who reads this document knows
  the window, the weights, and the manifest mechanism. Recall is a CI-gated
  number against a corpus, and the corpus is a record of shapes, not a promise
  about the next attack.
- **Bought quietly, and worth naming:** the freeze/seizure shape becomes
  claimable at all. Today it is invisible to every trigger the protocol
  offers — the balance never drops, so the exploit path sees nothing, and the
  governance verifier rejects it for want of a DAO program.
