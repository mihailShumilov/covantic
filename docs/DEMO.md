# The autonomous settlement demo

One command, run against devnet, that ends with the vault paying a policyholder
without anyone approving anything.

```bash
pnpm demo:autonomous --policy <id> --agent <name> --amount 600
```

Verified end to end on 2026-08-31: policy #26 paid **600 USDC**, on chain, via
`VerifyAndPayoutAgentError` — [`4XzTbn5g…`](https://explorer.solana.com/tx/4XzTbn5g3CA951T8hZ8nRGFyXVD1WDh1auvCv8zcNyrVnS5CRRxsxRR47NTonhHpM8JGMkHqqZCoPFro3yzioam9?cluster=devnet).
Vault 9,202.15 → 8,602.15; holder 299.71 → 899.71. **85 seconds** from the
breach landing to the payout confirming, and that run included an unrelated API
container restart in the middle of it.

## Why agent-error, and not the exploit path

The exploit path cannot be demonstrated by anyone holding the agent's key, and
that is a property rather than a limitation. `verify_and_payout_exploit` pays
on a movement the agent did **not** authorise. Only a token account's owner can
sign `Approve`, so a delegate staged for a demo resolves to `granted_by_agent`
and the claim is rejected. A payout there would be a payout on a hole.

Agent error is the honest one. The holder declares an operating envelope in
advance, the agent exceeds it, and the program re-derives the overshoot from a
balance it reads itself.

## What the clock measures

Setup is deliberately outside it. `MANDATE_DECLARATION_DELAY` is an hour and
shortening it would destroy the thing being shown: the declaration has to
predate the loss, or it is not a pre-commitment. The clock starts at the
breach.

| stage | typical |
| --- | --- |
| breach lands on devnet | t+0 |
| sweep finds it from the chain's own record | ≤ `EXPLOIT_SWEEP_INTERVAL_MS` |
| verdict, evidence hash, on-chain claim | +3–6 s |
| `LOCK_AGENT_ERROR` | 30 s on a `devnet-fast-lock` build |
| payout confirmed | +2–4 s |

## Setup, once per demonstration

A policy pays **once**: settling moves it to `ClaimPaid`, and the sweep stops
examining a policy that is not `Active`. Every run needs a fresh one.

```bash
# 1. Agent, funding, policy. --count is the fleet's target size, so pass one
#    more than it currently has.
API_URL=https://covantic.org pnpm --filter api exec tsx \
  scripts/fleet-bootstrap.ts --count <n+1> --coverage 2000 --duration 86400

# 2. The holder declares the envelope. Declare all five dimensions: each one
#    left silent is reported `unevaluated`, and each unevaluated dimension is
#    -0.03 on the confidence the payout lane needs.
pnpm --filter api exec tsx scripts/declare-agent-mandate.ts \
  --policy <id> --max-single 100 --max-window 150 --window 3600 \
  --min-retained 4600 \
  --counterparty 8SUV2eNzyrWfyZod1StCSuyBBTk5jruFydaMe8yRyLVC \
  --program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
  --keypair keys/fleet-holder.json

# 3. Wait out MANDATE_DECLARATION_DELAY — the script prints the exact time.

# 4. Give the agent a history. Six transfers of 20 USDC, spaced, staying
#    inside the envelope. Without a baseline the verdict carries a standing
#    -0.03 and can sit below the review bar on evidence that is otherwise
#    perfect.
pnpm agent:trigger --name <agent> --amount 20 --kind transfer
```

## Why the confidence arithmetic matters

`REVIEW_CONFIDENCE` is 0.75 and `CONFIDENCE_CEILING` is 0.92, below
`AUTO_PAY_CONFIDENCE` of 0.95 — so off-chain analysis alone can never release
funds, and a payout always needs the chain's own check. **Do not move these to
make a demo pass.** The only honest way to raise a score is to supply the
evidence that was missing:

```
0.60  base
+0.15  the breach is one the chain re-derives
+0.05  two or more declared dimensions crossed
-0.03  per dimension left unevaluated
-0.03  no outflow history for this agent
```

A sparse declaration and a fresh agent land at 0.63 and go to a human — which
is the product working, not failing. The full envelope plus a history reaches
0.85.

## Deployment settings the demo needs

| variable | demo | production |
| --- | --- | --- |
| `EXPLOIT_LOCK_SECONDS` | 30 | 3600 |
| `AGENT_ERROR_LOCK_SECONDS` | 30 | 21600 |
| `EXPLOIT_SWEEP_INTERVAL_MS` | 20000 | 120000 |
| `AGENT_ERROR_PROOF_ENABLED` | true | true |

The short locks need a program built with `--features devnet-fast-lock`. Against
a stock build the payout waits out the real lock instead — the keeper defers on
`LockPeriodNotElapsed` rather than recording a failure.

Do not take `EXPLOIT_SWEEP_INTERVAL_MS` below 20 s. At 10 s the sweep exhausted
the public devnet RPC's rate limit — 334 `Too Many Requests` in forty minutes —
after which every read failed, including the ones that decide claims.

## Reading a run that stops early

`review` and `rejected` are verdicts, not hangs, and the script says so. The
reason is in the claim's `verificationData`:

- `confidence_below_review_bar:0.63` — the evidence is thin. See the arithmetic
  above; this is the guarantee working.
- `proof_path_unavailable` — the settlement plan could not route to the on-chain
  instruction. Check `AGENT_ERROR_PROOF_ENABLED` in **both** the api and monitor
  containers: compose has no `env_file`, so a variable it does not name never
  reaches the process.
- `mandate_not_matured` — fired before the declaration delay elapsed.
- `trigger_tx_not_found` — neither the endpoint pool nor the indexer could
  resolve the signature. Usually rate limiting; check `/api/health/rpc`.
