# Backtest corpus — real Solana mainnet transactions

Everything in this directory came off the chain. Nothing was written by hand
except `incidents.json` (which signatures to fetch) and `manifest.ts` (what
each one is expected to produce, and why).

## Why it exists next to the hand-built corpora

`tests/fixtures/*-corpus.ts` holds constructed shapes. They are the record of
how the previous verifiers were wrong, and a regression that re-creates one of
those mistakes fails the build. What they cannot do is surprise anyone: every
field in them was chosen by the same people who wrote the detector, so they
only ever ask about transactions someone already thought of.

This corpus asks the other question. A few hundred transactions nobody
selected for their properties, plus the largest theft in the chain's history,
run through the pipeline exactly as a live claim would be.

It earned its place on the first run. Replaying the Wormhole attacker's
$18M USDC-for-SOL swap came back `confirmed` as oracle manipulation with a
$5M loss, because the attacker had bought 75% of a Raydium pool's SOL and the
resulting slippage looks identical to a squeeze: a fill far off every
reference, with the references themselves never moving. Nothing in the
hand-built corpus covered a trade large enough to move its own venue. The fix
is the `venue_depth_self_inflicted` discriminator in
`services/oracle/signatures.ts`.

## Layout

| Path                  | What it is                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `incidents.json`      | Signatures to fetch, with a note and a public write-up for each. Hand-maintained.                                                                |
| `cassettes/*.json`    | One documented-incident transaction each, verbatim from the RPC.                                                                                 |
| `negatives.ndjson`    | Ordinary mainnet transactions where a wallet ended up holding less. One cassette per line.                                                       |
| `unauthorised.ndjson` | Transactions where value left a token account whose owner neither signed nor held the moving authority. Written only when the sampler finds any. |
| `manifest.ts`         | Per-incident expectations. Hand-written, never generated from a run.                                                                             |

## Rebuilding it

```
pnpm backtest:fetch incidents
pnpm backtest:fetch negatives --per-block 22 --blocks-per-era 4 --max-negatives 320
```

No paid archival provider is needed. `getTransaction`, `getBlock` and
`getBlockTime` all reach long-term storage on `api.mainnet-beta.solana.com`,
which is what the fetcher uses by default; set `SOLANA_ARCHIVE_RPC_URL` to
point somewhere with a friendlier rate limit. The whole corpus was built from
the public endpoint.

## What a cassette holds, and what it does not

A cassette is the `getTransaction` response with `logMessages`, `rewards`,
`returnData` and the compute meter removed — most of a mainnet transaction's
bytes, and nothing the pipeline reads. Everything kept is an input to
`toRawTxView` or to the enhanced-shape reconstruction, so a replay sees a
complete transaction rather than a convenient subset. Re-fetch any signature
and diff it against the file.

Alongside the transaction sits every reference price the configured sources
reported for its block time. Those matter as much as the transaction: valuing
a February 2022 swap at today's SOL price would make every historical case
meaningless. Prices are frozen at fetch time and replayed through the same
`buildConsensusWindow` production uses.

`prices` records real coverage rather than an ideal one. A feed no source
could answer for is simply absent, and the pipeline then does what it does
live — declines to price the leg and routes the claim to review.

## The subject wallet

Ordinary transactions are replayed with the fee payer standing in for the
insured agent. Incidents name their subject in `manifest.ts`.

In every case the policy holder is `CovanticBacktestHo1derAbsentFromEveryTx1111`,
an address that appears in none of these transactions, and no mandate or
governance baseline is supplied. That is the least favourable configuration
available: value landing somewhere the holder controls is not a loss, so a
holder who _is_ present in the transaction would let the pipeline dismiss
cases on a fact the harness handed it. With a stranger as the holder, every
destination is foreign and every case has to be dismissed on its own evidence.
