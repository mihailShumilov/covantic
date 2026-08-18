import { lookupMint } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';
import { logger } from '../../utils/logger.js';
import { classifyPrograms } from '../verifiers/common.js';
import { reconstructExecution } from './execution.js';
import { isSourceUnavailable, type PriceOracle } from './types.js';

/**
 * Cheap screen for swaps worth a full verification.
 *
 * This exists because the detector for the trigger this protocol sells cover
 * against did not. `TransactionMonitor` raised `large_transfer` and
 * `failed_tx` and nothing else, so `oracle_deviation` was only ever produced
 * by the demo endpoint — in production, an agent could be squeezed on every
 * trade it made and no claim would ever open.
 *
 * The screen is deliberately loose. Its job is to decide what deserves a look,
 * not to decide anything: the verifier does the careful work, with retries, an
 * indeterminate lane, and an evidence bundle. So the bar here is a fraction of
 * the verifier's, and the failure direction is inverted on purpose.
 *
 * **Detection fails open; settlement fails closed.** If the price cannot be
 * established, this still raises a candidate — a false alarm costs one
 * verification, while a miss costs the policyholder their claim. The verifier
 * is where a claim can be denied, and it never denies on missing data.
 */

/** Screening bar, well under the verifier's. Catching a fill that turns out
 *  to be fine is cheap; missing one is not. */
const SCREEN_DEVIATION = 0.01;

/** Ignore trades too small for the outcome to matter, so dust routing does
 *  not fill the alert bus. */
const MIN_NOTIONAL_USD = 50;

export interface ScreenResult {
  /** Whether this transaction should raise an `oracle_deviation` candidate. */
  flagged: boolean;
  severity: 'warning' | 'critical';
  reason: string;
  detail: Record<string, unknown>;
}

const NOT_FLAGGED: ScreenResult = {
  flagged: false,
  severity: 'warning',
  reason: 'not_a_priceable_swap',
  detail: {},
};

/**
 * Decide whether a transaction by an insured agent looks like a bad fill.
 *
 * Returns quickly and without network access for anything that is not a
 * priceable two-sided swap, which is the overwhelming majority of traffic.
 */
export async function screenForOracleDeviation(
  tx: EnhancedTransaction,
  agentAddress: string,
  oracle: PriceOracle,
): Promise<ScreenResult> {
  const programs = classifyPrograms(tx);
  if (!programs.dex && !programs.lending) return NOT_FLAGGED;

  const execution = reconstructExecution(tx, agentAddress);

  // A lending or perps venue priced collateral from an oracle. Nothing here
  // can score that, but it is exactly the attack class worth surfacing.
  if (programs.lending && !programs.dex) {
    return {
      flagged: true,
      severity: 'warning',
      reason: 'lending_oracle_exposure',
      detail: { programs, shape: execution.shape },
    };
  }

  if (execution.shape !== 'swap' && execution.shape !== 'aggregated_swap') {
    return NOT_FLAGGED;
  }

  const blockTime = tx.timestamp;
  if (!Number.isFinite(blockTime) || blockTime <= 0) return NOT_FLAGGED;

  try {
    const sold = await valueSide(execution.sold, blockTime, oracle);
    const bought = await valueSide(execution.bought, blockTime, oracle);

    if (sold === null || bought === null) {
      // Something in this swap could not be priced. That is a gap in our
      // coverage, not evidence the fill was fine — hand it to the verifier,
      // which can retry and escalate.
      return {
        flagged: true,
        severity: 'warning',
        reason: 'unpriceable_swap_by_insured_agent',
        detail: {
          shape: execution.shape,
          sold: execution.sold.map((d) => d.mint),
          bought: execution.bought.map((d) => d.mint),
        },
      };
    }

    if (sold < MIN_NOTIONAL_USD) return NOT_FLAGGED;

    const deviation = (sold - bought) / sold;
    if (deviation < SCREEN_DEVIATION) return NOT_FLAGGED;

    return {
      flagged: true,
      severity: deviation >= 0.05 ? 'critical' : 'warning',
      reason: 'swap_priced_off_reference',
      detail: {
        deviation,
        soldValueUsd: sold,
        boughtValueUsd: bought,
        shortfallUsd: sold - bought,
        screenThreshold: SCREEN_DEVIATION,
      },
    };
  } catch (err) {
    if (isSourceUnavailable(err)) {
      // Sources being down must not silence detection. Raise it; the verifier
      // will retry against live sources when it picks the claim up.
      return {
        flagged: true,
        severity: 'warning',
        reason: 'price_source_unavailable_during_screen',
        detail: { source: err.source },
      };
    }
    logger.error({ err, agentAddress, tx: tx.signature }, 'prefilter: screen failed');
    return NOT_FLAGGED;
  }
}

/** Total USD value of one side, or null if any leg cannot be priced. */
async function valueSide(
  deltas: Array<{ mint: string; amountUi: number }>,
  blockTime: number,
  oracle: PriceOracle,
): Promise<number | null> {
  let total = 0;
  for (const delta of deltas) {
    const meta = lookupMint(delta.mint);
    if (!meta) return null;
    if (!meta.feedKey) {
      if (meta.kind !== 'stable') return null;
      total += delta.amountUi;
      continue;
    }
    const window = await oracle.getPriceWindow(meta.feedKey, blockTime);
    if (!window || !(window.anchor.value > 0)) {
      if (meta.kind === 'stable') {
        total += delta.amountUi;
        continue;
      }
      return null;
    }
    total += delta.amountUi * window.anchor.value;
  }
  return total;
}

export { SCREEN_DEVIATION, MIN_NOTIONAL_USD };
