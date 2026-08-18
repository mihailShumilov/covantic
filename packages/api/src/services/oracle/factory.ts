import { ConsensusPricer } from './consensus.js';
import { defaultCexSources } from './price-sources/cex.js';
import { PythHermesSource } from './price-sources/pyth-hermes.js';

/**
 * The production price reference: Pyth plus three exchanges.
 *
 * One factory, used by every caller, because the set of sources is a
 * protocol-level decision rather than a per-worker one. If the claim keeper
 * and the webhook screen disagreed about what "the price" is, a claim could
 * be raised on one view of the market and judged against another.
 *
 * The exchange half carries most of the weight. Pyth is chain-adjacent and
 * could in principle be the thing under attack; Binance, Coinbase and Kraken
 * cannot be moved by anything happening on Solana, which is what makes a
 * venue-local dislocation visible at all.
 *
 * Sources are cheap to construct and cache internally by (feed, timestamp),
 * so a fresh pricer per process is fine — but do not build one per request.
 */
export function buildPriceOracle(): ConsensusPricer {
  return new ConsensusPricer([new PythHermesSource(), ...defaultCexSources()]);
}
