import { ConsensusPricer } from './consensus.js';
import { defaultCexSources } from './price-sources/cex.js';
import { PythHermesSource } from './price-sources/pyth-hermes.js';

/**
 * The production price reference: Pyth plus five exchanges.
 *
 * One factory, used by every caller, because the set of sources is a
 * protocol-level decision rather than a per-worker one. If the claim keeper
 * and the webhook screen disagreed about what "the price" is, a claim could
 * be raised on one view of the market and judged against another.
 *
 * The exchange half carries most of the weight, and after this change it
 * carries nearly all of it. Pyth is chain-adjacent and could in principle be
 * the thing under attack; the exchanges cannot be moved by anything happening
 * on Solana, which is what makes a venue-local dislocation visible at all.
 *
 * Two of the six answer far less often than the list suggests, and both
 * shortfalls are recorded in every bundle's `missing[]` rather than implied.
 * Pyth is one of them and is currently off by decision: Hermes began charging
 * for access in August 2026, no key is configured, and the source reports
 * `not_configured` without spending a request on a certain 401. Kraken's
 * public OHLC route only retains a recent window and silently answers with
 * the latest candles for any older `since`, so it contributes nothing to a
 * retrospective lookup — which is every lookup this pipeline makes. OKX and
 * Bybit were added because of that: they serve minute candles years back, and
 * without them the retrospective consensus was two sources under a
 * three-source bar.
 *
 * Pyth stays in the list while it is off. Removing it would take the entry
 * out of `missing[]` too, and an evidence bundle that never mentions a
 * reference reads as though it was never meant to have one.
 *
 * Sources are cheap to construct and cache internally by (feed, timestamp),
 * so a fresh pricer per process is fine — but do not build one per request.
 */
export function buildPriceOracle(): ConsensusPricer {
  return new ConsensusPricer([new PythHermesSource(), ...defaultCexSources()]);
}
