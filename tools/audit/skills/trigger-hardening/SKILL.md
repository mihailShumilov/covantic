---
name: trigger-hardening
description: The house pattern for adding a new coverage trigger to Covantic, or rebuilding an existing one around verifiable evidence. Load when working on any TriggerType — detection, verification, adjudication, evidence bundles, or on-chain settlement — or when asked to make a trigger "provable", write a detection design doc, or add a labelled corpus. Encodes the structure the exploit, oracle-manipulation, governance-attack and agent-error rebuilds all converged on.
---

# Hardening a Coverage Trigger

Four triggers have been through this. They converged on the same shape, and the
shape is the point: it is what makes a payout auditable by someone who does not
trust the operator.

Read the closest sibling in `docs/*_DETECTION.md` before starting. Reuse its
spine; only depart where the new trigger genuinely needs something the others
do not have, and say so in the doc.

## The three guarantees

Every trigger targets these, and the design doc must open by stating which parts
are **not** reachable:

| | Guarantee | What it means |
|---|---|---|
| **G1** | Soundness on the auto-pay lane | The chain checks something *itself* before releasing funds. The backend cannot pay a loss it invented. |
| **G2** | Reproducibility | The verdict is a pure function of an immutable evidence bundle; `sha256(bundle)` is committed on chain. |
| **G3** | No silent failure | Every claim ends in exactly one of `paid`, `rejected(reason)`, `indeterminate→review`. Never closed because an RPC timed out. |

**100% detection recall is never reachable.** It is an open-world judgement
against an adaptive adversary who reads this repository. Recall is a measured,
CI-gated number against a labelled corpus — never a promise.

## The pipeline

```
webhook / crank ──▶ prefilter ──▶ alert (HMAC) ──▶ keeper ──▶ collect evidence
                    fails OPEN                                 (all I/O here)
                                                                     │
                                                                     ▼
                                                          EvidenceBundle
                                                                     │
                                                                     ▼
                                                    adjudicate(bundle)  ← PURE
                                                                     │
                              ┌──────────────────────┼──────────────────┐
                              ▼                      ▼                  ▼
                          rejected             indeterminate        confirmed
                     (evidence contradicts)      → review        → proof instruction
                                                                    fails CLOSED
```

**Detection fails open; settlement fails closed.** A screen that goes silent on
a missing input silently denies coverage. A settlement path that guesses on a
missing input is a theft vector.

## What the chain can actually prove

This is the design question, and it is different for every trigger. Pick the
mechanism that fits — do not force one that does not:

| Mechanism | Used by | Works when |
|---|---|---|
| **Verify a signed statement** | oracle manipulation | A third party signs facts about the past (Pyth guardians) |
| **Measure it twice and subtract** | exploit | The fact is a current account value, and a crank can checkpoint the "before" |
| **Test membership of a declaration** | governance attack | The holder can pre-commit to what is legitimate, and the chain can read the current state |
| **Compare against a declared bound** | agent error | Nothing external can establish it — only the holder's own prior statement can |

If none fit, the honest answer is that the trigger cannot settle automatically,
and the design should say so rather than inventing a proof.

### When the mechanism is a holder declaration

Two rules make it worth anything, and both have been got wrong once:

- **Holder-signed and matured on a delay**, checked against
  `claim_submitted_at`. A declaration usable the instant it is written proves
  nothing — a compromised key writes a convenient one first.
- **`prev_*` retained on refresh, zero on a first declaration.** The fallback
  stops a refresh landing after the incident from erasing the only usable
  "before"; seeding a first declaration's predecessor with its own values
  disables the delay entirely.

And: **absence of a declaration is `indeterminate → review`, never a
rejection.** It is a gap in our records, not the holder's consent.

## The build order

Deviating from this order is what produces a corpus that merely describes
whatever was built.

1. **Define the covered event** so a verifier could implement it. If you cannot
   write it as a checkable proposition, stop — that is the finding.
2. **Detection that fires.** A prefilter over the webhook payload, plus a crank
   for dropped deliveries. Check it is not the only producer being the demo
   endpoint.
3. **Evidence gathering.** All network I/O, into a typed bundle. Optional
   fields, so an old bundle stays replayable against a new adjudicator.
4. **The pure adjudicator.** No I/O, no `Date.now()`, no randomness. Export a
   `*_ADJUDICATOR_VERSION` and bump it rather than editing behaviour quietly.
   Degrade to `indeterminate` on missing inputs — never guess.
5. **The corpus, alongside step 4, not after it.** See below.
6. **On-chain settlement.** The instruction, the proof poster, a
   `settlement-plan` branch, `hasProofPath`, and a flag defaulting to false.
7. **Wire the seams:** `claim-oracle` dispatch, `claim-replay` `engineFor`,
   `adjudicatorVersionFor`, `EVENT_TO_TRIGGER`, `ANOMALY_SPECIFICITY`.
8. **Write the doc** as `docs/<TRIGGER>_DETECTION.md`, in the siblings'
   structure: implementation status, found-while-building, §0 what "100% proof"
   can mean, current state, defect inventory, target architecture, the phases,
   sequencing, honest summary.

## The corpus and its gate

Asymmetric, deliberately:

- **Negatives: zero confirmations is a hard CI failure**, with no allowance. A
  false positive means the vault paid for ordinary operation, and once one ships
  the protocol is insuring normal behaviour.
- **Positives: recall is a tracked floor** (0.8), not a target. The honest
  response to an ambiguous case is review.

Every negative should be a shape the *previous* implementation confirmed, or
would have. The list is a record of the specific ways the old approach got it
wrong, kept so the answers cannot quietly revert.

Also assert the structural properties: replay determinism, hash stability with
`collectedAt` excluded, the confidence ceiling below `AUTO_PAY_CONFIDENCE`, and
that every verdict carries a bundle.

## Things that have gone wrong, every time

- **Program membership decides nothing.** "An unknown program was invoked" and
  "a DEX was present" have each been the entirety of a verifier, and both were
  false-positive/false-negative engines. Carry `programs` in the bundle as an
  audit trail only.
- **Check the claim-slot cost of a new event.** A policy holds one open claim,
  and `review` and `indeterminate` are OPEN. Any event that can open a low-value
  claim can block a genuine exploit claim for that policy. Only map an event to
  a trigger if a verifier can actually adjudicate it; `undefined` is a decision.
- **Unit blindness.** Helius `tokenAmount` is UI-decimal, not raw. A threshold
  reasoned about as dollars must be compared against a value, per mint — not
  against a sum of token counts across mints.
- **Confidence must stay decorative-proof.** Cap at 0.92, below
  `AUTO_PAY_CONFIDENCE` (0.95), so off-chain analysis can never release funds
  alone. That gap is the guarantee.
- **The staleness reference point.** Where the lock is as long as the checkpoint
  allowance, comparing against `now` makes every payout unsatisfiable. Measure
  against `claim_submitted_at`.
- **Cross-trigger complementarity.** Adjudicators should be disjoint and
  exhaustive over the space they share. The exploit path rejecting
  `agent_authorized_movement` and the agent-error path rejecting
  `not_agent_authorized` is the pattern: each names the trigger the claim
  belongs to instead of dropping it.

## Deployment

New instructions need a redeploy, and the flag stays false until it lands. Two
failure shapes, and the difference decides whether enabling early is safe:

- **A missing declaration** resolves to `review` before any RPC — harmless.
- **A missing or stale checkpoint** makes the on-chain call revert, and the
  keeper records a failed payout as **`failed`, not `review`** — a valid claim
  becomes a dead one.

A trigger depending on both inherits the dangerous half. Say so in the flag's
comment in `env.ts` and in `.env.example`.
