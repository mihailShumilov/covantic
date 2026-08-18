/**
 * Pyth price access.
 *
 * The implementation moved to `services/oracle/price-sources/pyth-hermes.ts`
 * when historical (block-time anchored) lookups landed — Pyth became one
 * price source among several rather than "the" oracle. This module stays as
 * the injection seam every existing caller already imports.
 */
export {
  PythHermesSource as PythClient,
  FEED_IDS,
  DEFAULT_MAX_SKEW_SEC,
  type PythPrice,
} from '../services/oracle/price-sources/pyth-hermes.js';
