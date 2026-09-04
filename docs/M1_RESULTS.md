# M1 — Event-detection algorithm hardening: results

Scope of the milestone: improve the on-chain loss-event detection algorithm
across all four covered events — smart-contract exploit, oracle manipulation,
agent error, governance attack — with higher accuracy and coverage,
deterministic verification against Pyth and Helius data, and a backtest
against real Solana history. Proof is the open-source detection module plus
test and backtest results.

This document is the results half. The design and the defect inventory each
event type started from are in `EXPLOIT_DETECTION.md`,
`ORACLE_MANIPULATION_DETECTION.md`, `AGENT_ERROR_DETECTION.md` and
`GOVERNANCE_ATTACK_DETECTION.md`.

Revised 2026-09-04. Three things moved since the first edition and all three
are in the numbers below rather than in a changelog: the suites are larger,
three of the four on-chain proof paths are live in production and one has
settled a real policy, and the backtest now replays a second documented
incident — Mango Markets, which is the one that was actually an oracle
manipulation.

---

## 1. Where the detection module lives

| Event                  | Pipeline                                 | On-chain settlement                                                 |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| Smart-contract exploit | `packages/api/src/services/exploit/`     | `verify_and_payout_exploit.rs`, `checkpoint_balance.rs`             |
| Oracle manipulation    | `packages/api/src/services/oracle/`      | `verify_and_payout_v2.rs`                                           |
| Agent error            | `packages/api/src/services/agent-error/` | `verify_and_payout_agent_error.rs`, `declare_agent_mandate.rs`      |
| Governance attack      | `packages/api/src/services/governance/`  | `verify_and_payout_governance.rs`, `declare_governance_baseline.rs` |

Every pipeline has the same four stages — pre-filter, evidence collection,
pure adjudicator, settlement — and every adjudicator is a pure function of an
evidence bundle. All four are wired into the live dispatcher in
`services/claim-oracle.ts` and into detection through `transaction-monitor.ts`,
`workers/oracle-watcher.ts` and `workers/exploit-watcher.ts`. Nothing in the
table is unreferenced code.

---

## 2. Test and backtest results

### 2.1 Totals

| Suite                        | Result                              |
| ---------------------------- | ----------------------------------- |
| API unit + corpus + backtest | **753 passed**, 5 skipped, 66 files |
| Anchor on-chain integration  | **81 passed**, 3 files              |
| `tsc --noEmit`               | clean                               |
| `eslint src`                 | 0 errors                            |

The Anchor number is new information rather than a new suite. It is reported
here because until this change it was not being produced at all — see §5.

Both figures are from 2026-09-04. The first edition of this document reported
465 and 78; the API suite has roughly doubled since, and the Anchor figure is
read from the CI job rather than a local run — GitHub Actions run
[33899810278](https://github.com/mihailShumilov/covantic/actions/runs/33899810278)
on `e75e59a`, which is what makes it checkable by someone who is not us.

### 2.2 Labelled corpora — constructed shapes

79 hand-built cases, of which 57 are negatives. Each negative is a shape a
_previous_ verifier confirmed, or would have, so the file is a record of
specific past wrong answers rather than a list of things that seemed worth
testing.

| Detector               | Positives | Negatives |  Total |
| ---------------------- | --------: | --------: | -----: |
| Oracle manipulation    |         6 |        22 |     28 |
| Smart-contract exploit |         5 |        10 |     15 |
| Governance attack      |         5 |        14 |     19 |
| Agent error            |         6 |        11 |     17 |
| **Total**              |    **22** |    **57** | **79** |

The gate is asymmetric and enforced in CI: **any** confirmation on a negative
fails the build, with no allowance. Recall on the positives is a floor
(0.8), not a target, because the honest response to an ambiguous case is
review rather than payment.

### 2.3 Backtest — real Solana mainnet transactions

This is the part that did not exist before. `pnpm backtest:fetch` pulls real
transactions from long-term storage and freezes them, with the reference
prices that were true at their block time, into cassettes under
`packages/api/tests/fixtures/incidents/`. CI replays them with no network.

**Corpus.** 320 ordinary mainnet transactions, sampled from blocks at seven
points between 2022-03-23 and 2024-11-20, selected only on the objective
property that the fee payer ended the transaction holding less than it
started with — that is, the transactions most likely to be mistaken for a
loss. Nothing was selected on what the pipeline said about it. Each is
replayed through **all four** triggers, so a case cannot pass by being routed
somewhere quiet.

**Result: 1,280 judgements, zero confirmations, zero lamports of loss.**

| Trigger             | rejected | indeterminate (→ review) | confirmed |
| ------------------- | -------: | -----------------------: | --------: |
| Exploit             |      140 |                      180 |     **0** |
| Oracle manipulation |      243 |                       77 |     **0** |
| Governance attack   |        0 |                      320 |     **0** |
| Agent error         |        0 |                      320 |     **0** |

Governance and agent error resolve to review across the board because no
holder declaration exists for these wallets. That is the designed behaviour
for a policy whose holder has not declared a baseline or a mandate — never a
rejection — and it means those two columns say nothing about discrimination.
The exploit and oracle columns are the load-bearing ones.

The replay is run in the least favourable configuration available: the policy
holder is an address that appears in none of these transactions, and no
mandate or governance baseline is supplied. A holder present in the
transaction would let the pipeline dismiss cases on a fact the harness handed
it; with a stranger as the holder, every destination is foreign and each case
has to be dismissed on its own evidence.

**Documented incidents.** Two, twelve transactions, all replayed from mainnet.

*Wormhole, 2022-02-02* — six transactions: the forged mint of 120,000 unbacked
wETH, the 10,000 and 80,000 wETH bridge-outs, the two swaps into SOL and USDC,
and the USDC exit. Every one is expected not to confirm, and does not.

That expectation deserves stating plainly rather than being buried. The
Wormhole loss was not the shape this product covers: the bridge's Solana
custody never lost a balance, it gained a liability, because tokens were
minted against collateral that did not exist on Ethereum. No agent wallet's
balance fell, so no agent-wallet policy could have paid, and no amount of
detector tuning changes that. What the transactions test instead is the
harder half — they are among the largest value movements in the chain's
history, every one authorised by the wallet that made it, and a detector that
pays out on size, on an unfamiliar program, or on "a large outflow from a
young wallet" confirms all six.

*Mango Markets, 2022-10-11* — six transactions, added because Wormhole tests
size and Mango tests the thing this milestone names: the October 2022 exploit
**was** an oracle manipulation. The attacker bought MNGO on the open market
until the reported price carried collateral it could not support, then
borrowed $116M against it.

The attack wallet was read off the chain rather than out of a write-up. It is
`yUJw9a2PyoqKkH47i4yEGf4WXomSHMiK7Lp29Xs2NqM`, the signer of the 25M USDC
exit, and its entire history begins at 19:36 UTC on the day of the exploit —
which is itself the corroboration that it is the right wallet. The six are its
funding, a call into the Mango v3 program, the Jupiter swap that did the
pumping, a 1M USDC inflow, and the two exits of 20M and 25M USDC.

| Transaction                                     | Exploit path                    | Oracle path              |
| ----------------------------------------------- | ------------------------------- | ------------------------ |
| funding, 24,838 USDC in                         | rejected `no_net_loss`          | rejected `no_dex_interaction` |
| Mango v3 program call                           | rejected `agent_authorized_movement` | rejected `no_dex_interaction` |
| **Jupiter swap, 50,000 USDC → 210,545 MNGO**    | review `position_not_valued`    | review `no_price_feed_for_mint` |
| 1,049,584 USDC in                               | rejected `no_net_loss`          | rejected `no_dex_interaction` |
| 20,000,000 USDC out                             | rejected `agent_authorized_movement` | rejected `no_dex_interaction` |
| 25,000,000 USDC out                             | rejected `agent_authorized_movement` | rejected `no_dex_interaction` |

Governance and agent error resolve to review on all six, for the reason they
do everywhere in this corpus: nothing has been declared for this wallet.

The middle row is the honest one and the reason this table is here rather
than a sentence saying "Mango passes". The manipulation itself does **not**
reach the self-inflicted-slippage discriminator: it stops earlier, at
`no_price_feed_for_mint`, because MNGO is outside the mint registry and none
of the four exchanges the pricer reads still quotes it. Review is the correct
answer to an asset that cannot be valued — but it is not a demonstration that
the discriminator works, and reporting it as one would be the exact failure
mode §3.1 exists to catch. What the six do establish is that five of the
largest owner-signed movements of a real oracle attack are dismissed on their
own evidence, and the sixth is dismissed for a stated reason.

---

## 3. What the backtest found

Two false positives, both on the oracle-manipulation path, both fixed. Neither
was reachable from the hand-built corpus, and that is the argument for having
built this at all.

### 3.1 Slippage the claimant caused themselves

Replaying the Wormhole attacker's $18.04M USDC-for-SOL swap returned
**confirmed, $5.0M loss, reason `price_deviation`**.

The fill was 28% off every exchange reference, and the references had not
moved. That is the textbook signature of a venue-local squeeze. It is also
exactly what happens when a trader market-buys 75% of a Raydium pool's SOL
reserve: a constant-product pool prices an order against its own reserves, so
a large enough order moves the price by arithmetic rather than by anyone's
intent.

_Fix._ A new discriminator, `venue_depth_self_inflicted` in
`services/oracle/signatures.ts`, measures the largest share of any single
non-agent reserve the order consumed. Above 50% the shortfall is fully
accounted for by the order's own size and the claim is rejected
(`slippage_explained_by_order_size`); between 10% and 50% it goes to a
reviewer rather than a threshold.

Worth noting on cost: this measurement was previously listed as blocked on
archival pool state, alongside `pool_displacement`. It is not. Displacement
asks what a third party did to the pool beforehand and does need an archival
slot read; this asks only what the agent's own order did, and the answer is in
the transaction's own `preTokenBalances`.

### 3.2 Order-book settlement read as a swap

One transaction in the 320 returned **confirmed, $116 loss**. It was a Serum
market-making transaction that posts 2.549 SOL for a new order while settling
322.88 USDC from a different order that had matched earlier. Netted as a swap
it implies $126 per SOL against a $172 market.

The general fault: on a central-limit order book the net balance change of a
transaction need not be a single exchange, so an implied price derived from it
is not a price.

_Fix._ Order books are now classified separately from AMMs and aggregators
(`ORDERBOOK_PROGRAMS` in `utils/helius.ts`, `orderBook` on
`ProgramClassification`), and a transaction touching one resolves to
`orderbook_execution_not_reconstructible` — review, not a number.

_Cost, stated honestly:_ this also suppresses genuine oracle manipulation
executed on Serum, OpenBook or Phoenix. Measuring those properly needs the
market's own fill records rather than balance deltas. Until that exists the
claim goes to a reviewer, which is the right side to err on but is a real
coverage gap and is listed as one in §6.

---

## 4. Deterministic verification against Pyth and Helius

| Property                                                                    | Where                                                                                             | Status                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- |
| Every price lookup anchored to the transaction's block time, not to "now"   | `oracle/price-sources/pyth-hermes.ts`, `oracle/tx-time.ts`                                        | done                    |
| Guardian-signed Pyth update retained verbatim (`binary.data[0]`)            | `oracle/types.ts` `PricePoint.raw`                                                                | done                    |
| The **program** verifies that signed update before paying                   | `verify_and_payout_v2.rs` — `Account<'info, PriceUpdateV2>` from `pyth-solana-receiver-sdk` 2.0.0 | deployed, flag off (§6) |
| Chain record, not indexer payload, decides authorization                    | `exploit/raw-tx.ts` — signer flags and per-side token-account owners                              | done                    |
| Canonical JSON → `bundleHash`; `verdictHash = sha256(bundleHash ‖ verdict)` | `oracle/hash.ts`                                                                                  | done                    |
| Same bundle re-derives the same verdict, byte for byte                      | corpus + backtest determinism tests                                                               | done                    |
| Stored evidence re-adjudicated and diffed against what was recorded         | `scripts/claim-replay.ts`                                                                         | done                    |
| Off-chain analysis cannot reach the auto-pay lane                           | `confidence-lanes.ts` — adjudicator ceiling 0.92 against a 0.95 bar                               | done                    |

The last row is the structural one. Every automatic payout requires the
chain's own measurement — a guardian-signed price the program verified, or a
balance drop it measured — because the gap between the two constants makes the
top lane unreachable by off-chain evidence alone.

### 4.1 Price reference coverage — corrected

Two problems surfaced while building the backtest, both affecting live
verification and not only the tests.

**Pyth Hermes now requires credentials.** `hermes.pyth.network` answers
`401 unauthorized` to anonymous requests on every route, including
`/v2/updates/price/latest`. The source's own comment claimed "free, no API key
required". The host and an optional bearer credential are now configurable
(`PYTH_HERMES_URL`, `PYTH_HERMES_API_KEY`), and a 401 raises the same
unavailability error as any other outage: Pyth drops out of the consensus, the
reason is recorded in the bundle's `missing[]`, and the claim resolves against
the remaining references one source short rather than silently.

Since that was written Pyth has said what the replacement is. The anonymous
host was retired on 2026-08-26 in favour of `pyth.dourolabs.app/hermes`, same
routes and same response shapes, with the credential passed as
`Authorization: Bearer`. The default now points there, which is what the
client already sent, so the only outstanding piece is a key from Pyth
Terminal. Verified against the live host while writing this: no credential
answers `401`, an invalid one answers `403` — the endpoint is reachable and
discriminating, not simply gone.

**Kraken contributed nothing to any retrospective lookup.** Its public OHLC
route ignores a `since` older than the ~720 candles it retains and answers with
the _latest_ window instead, so a lookup for any past minute matched no bucket
and reported `no_data`. Since every claim is retrospective by construction,
that was every claim.

Together those left real retrospective consensus at two sources — Binance and
Coinbase — under a three-source bar. Two references with deep history were
added (`OkxSource` on `history-candles`, `BybitSource`), taking retrospective
CEX coverage to four. Verified against 2022 data while building the corpus:
the Wormhole cassettes price SOL/USD, BTC/USD and ETH/USD from four
independent exchanges at the February 2022 block time.

---

## 5. CI was reporting a result it never produced

The `test-anchor` job passed in 46 seconds without compiling the program or
running a single on-chain test. Four separate faults, all of which had to be
fixed before the job did anything — and the last of them only became visible
once the first three were, which is what a job that exits zero on failure
costs you:

1. **The CLI never installed.** `npm i -g @coral-xyz/anchor-cli@0.31.1` ships
   a launcher that cannot find its own binary (`EACCES`, then "Could not find
   globally installed anchor") and **exits zero**. Both `anchor build` and
   `anchor test` were silent no-ops under a green check. The version was also a
   major behind what this program needs. Now installed from crates.io at the
   version `Anchor.toml` declares.
2. **No local validator.** Anchor 1.x runs integration tests against
   `surfpool`, not `solana-test-validator`, and fails with "Failed to spawn
   `surfpool`" when it is absent. It is now installed from its release
   tarball.
3. **The provider pointed at devnet.** `Anchor.toml` sets devnet for
   day-to-day work; inherited in CI, the test run would have tried to deploy
   to a live cluster with a wallet CI does not have. The job now passes
   `--provider.cluster localnet` explicitly, and `--ignore-keys` on the build
   because the deploy keypair is deliberately not in the repo.
4. **The Solana toolchain was a major version behind.** With the CLI working,
   `anchor build` reached `cargo-build-sbf` and panicked on a bare `NotFound`:
   Anchor 1.x drives it out of the Solana install and the 2.1.x layout is not
   the one it expects. Pinned to Agave 3.1.14, the version the build and the
   suite were validated against.

A `Verify toolchain` step with `set -euo pipefail` and an exact version match
now fails loudly if any of that regresses, rather than downgrading the two
steps below it into no-ops.

Validated locally on the same commands the workflow runs, and now in CI:
`anchor build --no-idl --ignore-keys` succeeds, and
`anchor test --skip-build --provider.cluster localnet` runs **78 tests across
3 files, all passing**. The job takes about seven minutes, most of it
compiling the CLI, against the 46 seconds it used to take to do nothing.

The working toolchain, for anyone reproducing it: Agave 3.1.14,
`anchor-cli` 1.0.2 from crates.io, surfpool 1.5.0.

---

## 6. Known limits

Listed because a milestone report that only contains good news is not a
measurement.

- **Three of the four proof paths are live; the fourth waits on a credential.**
  This has moved since the first edition. The devnet program was redeployed on
  2026-08-28, and `EXPLOIT_PROOF_ENABLED`, `GOVERNANCE_PROOF_ENABLED` and
  `AGENT_ERROR_PROOF_ENABLED` are true in production. They are not theoretical:
  on 2026-09-04 policy #64 settled through `verify_and_payout_agent_error`,
  100 USDC paid 87.5 seconds after the breach, on a payout the program bounded
  by a balance drop it measured itself —
  [`3s83DD9Z…`](https://explorer.solana.com/tx/3s83DD9Z1JKdjLe6mFQ9Vbe7GbJ4SjrRXgd7Mt1TtsWHzQgFmuPgyh8AQss5U25QrYeNF6qGPDcX8mzzCGewhu4J?cluster=devnet).

  `ORACLE_PROOF_ENABLED` is still false, and the blocker is not the program.
  `verify_and_payout_v2` is deployed and its tests pass; what is missing is the
  guardian-signed update it verifies, which comes from Hermes, which now needs
  a paid credential (§4.1). Until a key is set an oracle claim can reach
  `confirmed` on the four exchange references but never the auto-pay lane —
  it goes to review, which is the designed behaviour for evidence the chain
  cannot re-derive, not a fallback to paying on our word.
- **Order-book venues route to review.** §3.2. Serum, OpenBook and Phoenix
  fills cannot be reconstructed from balance deltas; doing it properly needs
  the market's fill records.
- **The mint registry prices eight mints.** Anything outside it cannot be
  valued, which is why `position_not_valued` accounts for 177 of the 320
  exploit-path outcomes in the backtest. Those go to review. Widening the
  registry is mechanical but each entry must be verified on chain first — a
  wrong `decimals` mis-scales a loss by orders of magnitude.

  The Mango replay puts a price on that limit. The one transaction in this
  corpus that *is* an oracle manipulation resolves to review rather than to a
  verdict, because MNGO is outside the registry and none of the four exchanges
  still quotes it — checked while adding the case, not assumed. Adding a mint
  nobody trades any more would mean inventing a reference, so the case stays
  as it is and says so.
- **The backtest corpus spans 2022-03 to 2024-11.** The sampler reached its
  320-transaction cap before the 2025 and 2026 blocks in its era list. Raising
  `--max-negatives` extends it.
- **The unauthorised-outflow probe is thin.** Forty sampled blocks yielded one
  transaction where value left an account whose owner neither signed nor held
  the moving authority _and_ the owner ended down. It is a structural probe
  that widens with the corpus, not a recall measurement — and it could not be
  one, because its selection rule overlaps the authorization test the exploit
  verifier applies.
- **Two documented incidents are replayed, not a dozen.** Attacker addresses
  are what make an incident locatable on chain, and they are published far less
  often than the incidents themselves — Mango was reachable because one exit
  transaction is cited publicly, and everything else came from following that
  wallet. `incidents.json` takes one line per signature; the fetcher and the
  expectations do not change, so the next one is an afternoon's work rather
  than a redesign.
- **`victim_cohort` needs a database lookup wired into the keeper** before it
  fires in production. It reports as unevaluated until then, never as absent.

---

## 7. Reproducing all of it

```bash
pnpm install
pnpm --filter shared build

# Tests and backtest — no network, replays the committed corpus
pnpm --filter api test

# On-chain suite (needs the Rust/Solana toolchain and surfpool)
cd packages/anchor
anchor build --no-idl --ignore-keys
anchor test --skip-build --provider.cluster localnet

# Rebuild the backtest corpus from mainnet
pnpm backtest:fetch incidents
pnpm backtest:fetch negatives --per-block 22 --blocks-per-era 4 --max-negatives 320
```

The fetcher needs no paid archival provider: `getTransaction`, `getBlock` and
`getBlockTime` all reach long-term storage on `api.mainnet-beta.solana.com`,
which it uses by default. Set `SOLANA_ARCHIVE_RPC_URL` for a friendlier rate
limit.
