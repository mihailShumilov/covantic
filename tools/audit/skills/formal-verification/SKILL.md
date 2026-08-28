---
name: formal-verification
description: Turn Covantic's stated invariants into executable, machine-checked properties — solvency, fund conservation, authorization, determinism, and state-machine safety — using property-based testing over the bankrun Anchor harness and the pure adjudicators. Load when asked to prove, verify, or formally check an invariant, to write property/fuzz tests, to harden the settlement paths against a class of input rather than a case, or during phase P4 of an audit engagement.
---

# Proving the Invariants

`CLAUDE.md` lists invariants in prose. Prose invariants decay: the code moves,
the sentence does not, and nobody notices until a payout is wrong. This skill
converts each into a test that fails when the property stops holding.

**A property test that has never failed proves nothing.** Every invariant here
ships with a mutation: break the code it protects, watch the test go red, put
the code back. An invariant test that stays green against a deliberately broken
build is worse than no test, because it is cited as evidence.

## The ladder

Climb only as far as the property needs. Most stop at rung 3.

| Rung | Technique | Use when |
|---|---|---|
| 1 | Assertion in the code (`require!`, `invariant()`) | The property must hold at runtime in production |
| 2 | Example test | One concrete case, usually a regression |
| 3 | **Property test over generated inputs** | The property must hold for *all* inputs in a range — the default here |
| 4 | Exhaustive small-scope check | The state space is genuinely small (state-machine transitions, event→trigger mapping) |
| 5 | Differential / replay | A second implementation or a stored history exists to agree with |

## Harnesses in this repo

- **On-chain properties** → `packages/anchor/tests/*.test.ts`, vitest over
  `solana-bankrun` + `anchor-bankrun`. Bankrun is fast enough to run hundreds of
  generated instruction sequences per property; `anchor test` against a
  validator is not. Run with `pnpm --filter @covantic/anchor test`.
- **Off-chain pure properties** → `packages/api/tests/*.test.ts`, vitest. The
  adjudicators are pure by contract, which makes them ideal property targets:
  no mocking, no clock, no network.
- **Generators** → `fast-check`, as a devDependency of the package under test.
  Add it rather than hand-rolling randomness; hand-rolled random tests are not
  reproducible and there is no shrinking, so a failure arrives unreadable.
- **Replay** → `pnpm --filter api claim:replay <id>` re-derives a stored verdict
  from its evidence bundle. This is rung 5 and it already exists — use it.

## The invariants to prove

Name each test after its invariant ID and keep the ID in the report.

### INV-SOLV — Solvency

> After any sequence of `stake`, `unstake`, `create_policy`, `expire_policy`,
> `cancel_policy` and any settlement instruction, the vault's token balance is
> at least the sum of its recorded obligations.

Property test over generated instruction sequences in bankrun. Generate the
*sequence*, not just the arguments — order is where this breaks. Assert after
every step, not only at the end.

### INV-CONS — Conservation

> No instruction creates or destroys vault USDC. For every settlement, the
> decrease in vault balance equals the increase in the holder's ATA, and equals
> the amount the program computed for itself.

The third clause is the one that matters: it is what separates
`verify_and_payout` (trusts the oracle's number) from the v2/exploit/governance
paths (measure or verify their own). A property that only checks the first two
clauses will pass on the legacy path and tell you nothing.

### INV-AUTH — Authorization

> No path releases funds on off-chain analysis alone.

Two parts, both testable:

1. **In code** — `CONFIDENCE_CEILING` (0.92) < `AUTO_PAY_CONFIDENCE` (0.95), and
   all four adjudicators cap at the ceiling. Property: for every generated
   evidence bundle, `adjudicate(bundle).confidence <= CONFIDENCE_CEILING`. This
   is a pure property with no harness cost — run it over every adjudicator.
2. **On chain** — every settlement instruction rejects a caller who is not the
   stored oracle authority, and every account it spends from is derived rather
   than accepted. Generate substituted accounts (wrong mint, wrong owner, wrong
   PDA, attacker-controlled ATA) and assert each is rejected.

### INV-DET — Determinism

> `adjudicate(bundle)` is a pure function. The same bundle yields the same
> verdict forever.

Property: for every generated bundle, two calls agree, and `sha256(bundle)` maps
to one verdict. Reinforce with the static check — no `Date.now()`, no
`Math.random()`, no `new Date()`, no I/O in `services/{oracle,exploit,governance,agent-error}/adjudicate.ts`.
Then rung 5: replay every stored claim and require the verdict to match, with
`ADJUDICATOR_VERSION` accounting for any that do not.

### INV-STATE — State machine

> No policy or claim reaches a terminal state twice. No claim pays twice.

Exhaustive at rung 4: enumerate the transitions and assert every terminal state
is absorbing. Then a bankrun property: replaying the same settlement
instruction, or racing two settlements on one claim, must fail the second.

### INV-THREE — Three-valued verification

> Verification is `confirmed | rejected | indeterminate`, and an unavailable
> input yields `indeterminate`, never `rejected`.

Property over bundles with fields deliberately absent or unreachable: assert the
verdict is never `rejected` when the evidence is *missing* rather than
*contradictory*. This invariant protects policyholders, so it fails quietly —
nobody complains about a claim that was never paid.

### INV-ARITH — Arithmetic

> No premium, payout, coverage bound or vault total silently wraps or saturates.

Property over the full numeric range at the boundaries — `u64::MAX`, zero,
one-below and one-above every constant in `shared/constants.ts`. Saturating
arithmetic is as much a finding as wrapping: a saturated payout is a wrong
payout that does not panic.

## Writing a property well

- **Generate the adversary's input, not the happy path.** If your generator only
  produces well-formed bundles, you have written a slow example test.
- **Shrink matters.** Use `fast-check` arbitraries so a failure reduces to the
  minimal counterexample; a 400-line random bundle is not a bug report.
- **Seed and record.** Pin the seed on failure and commit the counterexample as
  a regression example test at rung 2. The property stays; the case joins it.
- **Assert the invariant, not the implementation.** `payout <= coverage` is an
  invariant. `payout === computePayout(x)` restates the code and will agree with
  it while both are wrong.
- **Keep properties out of the settlement path's mocks.** A property over a
  mocked chain proves the mock is consistent.

## What this does not establish

Say so in the report. Property testing samples; it does not prove. It cannot
establish absence of a bug outside the generator's range, anything about the
deployed binary as opposed to the source, or detection recall against an
adaptive adversary — which is an open-world problem and is measured against the
labelled corpora in `packages/api/tests/*-corpus.test.ts`, never promised.
