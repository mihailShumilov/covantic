# The autonomous settlement demo

One command per step, run against devnet, ending with the vault paying a
policyholder without anyone approving anything.

Verified end to end on 2026-09-03: policy #28 paid **500 USDC** through
`VerifyAndPayoutAgentError` — [`2EUpjaxW…`](https://explorer.solana.com/tx/2EUpjaxWGNxeHXL6X2qxobRQHsyMd75TJ3KXipF8Dk8Boe9QUuubCvJnF5h3YKauAesh26pXDGudY1zh11pBMJVj?cluster=devnet)
— against a premium of **0.96 USDC**. **82.2 seconds** from the breach to the
payout confirming.

That ratio is the product, not a demo artefact. A premium is a rate on the
cover for a term; premiums are pooled; the few holders who claim are paid in
full from what the many paid in. Policy #55, bought under the derived envelope,
paid the same 500 against a premium of 0.29 in 101.7 seconds.

`pnpm demo:arm` prepares a policy in one command and `pnpm demo:status` hands
you the line to run, along with what each armed policy will pay. The
walkthrough below is the same thing step by step.

## What this demonstrates, and what it does not

It demonstrates **autonomous settlement**: a loss detected from the chain's own
record, adjudicated against an envelope derived from what the agent actually
does, and paid by an instruction that re-derives the amount from a balance it
reads itself. No human anywhere in that path.

The premium is a rate on the cover for a term — the tier, the amount and the
duration, and nothing else. The payout is the whole overshoot past the derived
cap, paid in full, and the cap is the deductible. That is the trade insurance
makes: many holders pay a small rate, few claim, and the ones who do are paid
from the pool rather than from their own premium.

What it does **not** demonstrate is a trigger the holder cannot arrange. An
agent error is a loss the agent caused with its own authority, and the agent
answers to its holder. Two things carry that risk, and neither is a bound on
the amount: the envelope is derived from the agent's own record rather than
chosen, so a breach means it moved several times what it ordinarily moves; and
the first slice of any breach is a deductible the holder carries. What is left
is ordinary moral hazard, which underwriting answers rather than arithmetic.

Say that out loud rather than hoping nobody asks. Every insurer lives with it.

## The scenario

### 1. Give the agent a record — 6 movements, ~2 minutes

```bash
pnpm --filter api exec tsx scripts/agent-wallet.ts create --name <agent>
pnpm --filter api exec tsx scripts/agent-wallet.ts fund   --name <agent> --usdc 800
pnpm --filter api exec tsx scripts/agent-wallet.ts trigger \
  --name <agent> --amount 20 --kind transfer     # six times, ~25s apart
```

This comes **first**, and the order is the point. The operating envelope is
derived from what the agent actually does — the cap is five times its ordinary
movement — so an agent nobody has watched gets a cap equal to its balance, one
nothing can cross, since it cannot move more than it holds. An underwriter
reads a record; it does not wait for one.

Six is the count because `MIN_OUTFLOW_OBSERVATIONS` is five, and without a
baseline the verdict also carries a standing −0.03 on confidence.

### 2. Buy the policy — 40 seconds

```bash
API_URL=https://covantic.org pnpm --filter api exec tsx scripts/fleet-bootstrap.ts \
  --agent <agent> --coverage 600 --duration 604800
```

```
envelope: cap 100 USDC (history, ordinary 20)
risk:   tier=1 premium=287671 raw (≈ 0.2877 USDC)
policy #55 bought: 2QB5TYoS…
```

Two numbers worth pausing on. The cap is 100 because this agent ordinarily
moves 20, and nothing on the form could have set it otherwise. The premium is
0.29 because that is 250 bps a year on 600 of cover for seven days — a rate on
an amount for a term, which is what a premium is.

### 3. Wait — about two minutes, and two clocks are running

`MANDATE_DECLARATION_DELAY` is a minute on a `devnet-fast-lock` build and an
hour in production. The wait is the mechanism, not an inconvenience: an
envelope that could be fixed *after* watching a loss would prove nothing.

The other clock is the balance checkpoint. The payout proves the loss by
comparing the covered account against a checkpoint the sweep writes on its own
schedule — `EXPLOIT_SWEEP_INTERVAL_MS`, a minute here — and it has to predate
the movement. Break the envelope before the first one lands and the drop
measures zero: the claim verifies, computes the whole overshoot, and then fails
on chain with `DropBelowMinimum`, which from the audience looks exactly like
the protocol refusing to pay.

`pnpm demo:arm` folds both into the time it prints, so `demo:status` does not
call a policy ready until each has passed.

### 4. Break it — about 100 seconds, and this is the part to watch

```bash
pnpm demo:autonomous --policy <id> --agent <agent> --amount 600
```

```
t+  0.4s  agent moves 600 USDC against a declared cap
t+  2.8s  transfer landed
t+ 61.2s  claim → verifying         the sweep found it in the chain's own record
t+ 65.4s  claim → approved          verdict reached, claim filed on chain
t+ 93.2s  claim → paying            the program's own lock elapsed
t+101.7s  claim → paid — 500 USDC
```

600 against a 100 cap is a 500 USDC overshoot, and the same movement crosses
the declared window cap — two dimensions, which is what carries the confidence
from 0.63 to 0.80. The first 100 is the deductible; the rest is paid in full,
against a premium of 0.29.

The thirty seconds between `approved` and `paying` are the on-chain lock. Say
what it is rather than waiting through it: the window in which a compromised
oracle key can still be stopped before money moves. It is six hours in
production.

## Preparing ahead

Two things are spent by every run, and neither comes back.

A policy pays **once** — settling moves it to `ClaimPaid` and the sweep stops
examining it. And the **agent** is spent too: the demo movement is six times
the cap, so once it has been made, that movement *is* what the agent ordinarily
does, and the next quote derives a cap it cannot cross. `demo:arm` records
those refusals and creates a fresh agent when no reusable one is left.

`pnpm demo:status` lists what is ready, what is still maturing, and what each
armed policy will pay.

## When a run stops early

`review` and `rejected` are verdicts, not hangs, and the script says so.

- `confidence_below_review_bar` — the evidence is thin. Almost always a missing
  history (step 1), which is also what the counterparty allowlist costs: it is
  not derivable, so it is left silent, and silence is 0.03.
- `ENVELOPE_NOT_INSURABLE` at the quote — this agent has already made the demo
  movement, so its ordinary behaviour now sits above the cap any envelope would
  give it. Use another agent.
- `COVERAGE_ABOVE_MAX` at the quote — more cover than the agent holds, or more
  than the vault's stake supports. The response says which and gives the
  ceiling.
- `DropBelowMinimum` at the payout — the breach beat the first balance
  checkpoint. Wait out step 3.
- `mandate_not_matured` — fired inside the declaration delay.
- `AttestationMandateMismatch` at purchase — the envelope quoted and the
  envelope declared are not the same one. Check every field, including the
  allowlists.
