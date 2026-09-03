# The autonomous settlement demo

One command per step, run against devnet, ending with the vault paying a
policyholder without anyone approving anything.

Verified end to end on 2026-09-03: policy #41 paid **500 USDC** through
`VerifyAndPayoutAgentError` — [`3S9vsCET…`](https://explorer.solana.com/tx/3S9vsCETzytXAF9nFcakEcYynupD2JnVCyXXWGm4fbCF74msEgTJzsWC1UngiSuAXHQU5MQFp2BFCxr2aLaDYV3q?cluster=devnet).
**75.0 seconds** from the breach to the payout confirming, against a premium of
700.96 on 2,000 of coverage.

Two paths lead here. `pnpm demo:arm` prepares one in a single command and is
what `pnpm demo:status` hands you; the walkthrough below is the same thing
step by step, with smaller numbers that are easier to narrate. The armed path
funds 800 against a 100 cap and moves 600, so it pays 500 — the walkthrough
funds 700 against a 650 cap and moves 670, so it pays 20. The arithmetic is
identical; only the scale differs.

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

### 1. Buy a policy, envelope and all — 40 seconds

```bash
API_URL=https://covantic.org pnpm --filter api exec tsx scripts/fleet-bootstrap.ts \
  --count <fleet size + 1> --fund 700 --cap 650 --coverage 200 --duration 604800
```

Creates an agent, funds it with 700 USDC, and buys a policy whose operating
envelope is declared **in the same transaction**. Prints the policy number and
the agent name; keep both.

```
funded: 0.1 SOL + 700 USDC
risk:   tier=1 premium=50095890 raw (≈ 50.0959 USDC)
policy #37 bought: 2P7VjoRE…
```

The premium is worth pausing on. 50 USDC is exactly `700 − 650` — what the
holder could walk this agent over its own cap for. Widen the cap above the
balance and it costs nothing; narrow it and it costs more, in exact step.

### 2. Give the agent a history — 6 movements, ~6 minutes

```bash
pnpm --filter api exec tsx scripts/agent-wallet.ts trigger \
  --name <agent> --amount 5 --kind transfer     # six times, ~70s apart
```

Ordinary movements, well inside the envelope. Without them the verdict scores
0.63 against a 0.75 bar and goes to a human — correctly, because "this agent
exceeded a limit" means nothing without knowing what it normally does.

**Five is the amount, not twenty.** Six movements of 20 would take the balance
from 700 to 580, under the 650 cap, and the breach in step 4 becomes impossible.

This step can run long before the demo. Its output is a row per movement in
`agent_outflow_events`, and it does not expire.

### 3. Wait out the declaration — 60 seconds

`MANDATE_DECLARATION_DELAY` is a minute on a `devnet-fast-lock` build and an
hour in production. The wait is the mechanism, not an inconvenience: a mandate
a holder could declare *after* watching a loss would prove nothing. Step 2
covers it several times over.

### 4. Break it — 75 seconds, and this is the part to watch

```bash
pnpm demo:autonomous --policy <id> --agent <agent> --amount 670
```

```
t+ 0.3s  agent moves 670 USDC against a declared cap
t+ 3.9s  transfer landed
t+35.2s  claim → verifying          the sweep found it in the chain's own record
t+39.4s  claim → approved           verdict reached, claim filed on chain
t+68.5s  claim → paying             the program's own lock elapsed
t+74.7s  claim → paid — 20 USDC
```

670 against a 650 cap is a 20 USDC overshoot, and the same movement crosses the
declared window cap — two dimensions, which is what carries the confidence from
0.63 to 0.80.

The thirty seconds between `approved` and `paying` are the on-chain lock. Say
what it is rather than waiting through it: the window in which a compromised
oracle key can still be stopped before money moves. It is six hours in
production.

## Preparing ahead

A policy pays **once** — settling moves it to `ClaimPaid` and the sweep stops
examining it. `pnpm demo:status` lists what is ready and what is still maturing,
along with the addresses a policy can be bought for.

## When a run stops early

`review` and `rejected` are verdicts, not hangs, and the script says so.

- `confidence_below_review_bar` — the evidence is thin. Almost always a missing
  history (step 2) or an envelope with dimensions left silent, each of which
  costs 0.03.
- `ENVELOPE_NOT_INSURABLE` at the quote — the declared cap sits under what the
  agent normally moves, so a breach is scheduled rather than risked. Widen it.
- `mandate_not_matured` — fired inside the declaration delay.
- `AttestationMandateMismatch` at purchase — the envelope quoted and the
  envelope declared are not the same one. Check every field, including the
  allowlists.
