import { LOCK_PERIODS } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';
import type { PythClient } from '../../utils/pyth.js';
import type { VerificationResult } from '../claim-oracle.js';
import { capToCoverage, classifyPrograms, uiToRaw } from './common.js';

/** Deviation above this fraction between the tx's implied price and the
 *  Pyth spot price triggers an OracleManipulation approval. 3% is
 *  generous enough to survive spot-vs-tx-timing noise (Pyth updates
 *  every ~400ms, tx settles in ~0.5s) without whitelisting a real
 *  manipulation (those typically push the price 10%+ for a block). */
const DEVIATION_THRESHOLD = 0.03;

/** Well-known mints we can price via Pyth. Extend cautiously. */
const PRICE_FEED_FOR_MINT: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL/USD', // wrapped SOL
  // Native SOL (appears in nativeTransfers, not tokenTransfers)
  SOL: 'SOL/USD',
};

/** USDC mints we treat as the "stable" leg of a swap. */
const STABLE_USDC_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // mainnet USDC
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // devnet USDC — keep a concrete fallback
]);

/**
 * Verifier for TriggerType.OracleManipulation — approve when the DEX
 * swap encoded in this tx executed at a price meaningfully different
 * from Pyth spot.
 *
 * Requirements for a positive verification:
 *   1. At least one DEX program in instructions.
 *   2. One in-leg + one out-leg in tokenTransfers, where one side is
 *      USDC (or equivalent stable) and the other has a Pyth feed.
 *   3. Implied price `|priced_token_amount / usdc_amount|` deviates
 *      from Pyth spot by ≥ DEVIATION_THRESHOLD.
 *
 * Loss is the deviation in USDC terms, capped by coverage.
 *
 * Known limitation: Pyth Hermes gives spot only. A tx seen after the
 * price has moved naturally will score higher deviation than it deserves.
 * Callers that need higher precision should swap PythClient for the
 * Benchmarks TWAP once that wrapper exists.
 */
export async function verifyOracleManipulation(
  tx: EnhancedTransaction,
  agentAddress: string,
  coverageRaw: number,
  pyth: PythClient,
): Promise<VerificationResult> {
  const lockPeriod = LOCK_PERIODS.ORACLE_MANIPULATION;
  const programs = classifyPrograms(tx);

  if (!programs.dex) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'no_dex_interaction',
        programs,
        note: 'OracleManipulation requires a DEX swap in the transaction.',
      },
      lockPeriod,
    };
  }

  // Identify swap legs that involve the agent.
  const outgoing = (tx.tokenTransfers ?? []).filter((t) => t.fromUserAccount === agentAddress);
  const incoming = (tx.tokenTransfers ?? []).filter((t) => t.toUserAccount === agentAddress);
  if (outgoing.length === 0 || incoming.length === 0) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'incomplete_swap',
        note: 'Agent did not both send and receive a token in this tx.',
      },
      lockPeriod,
    };
  }

  // Pick the largest-leg pair as the "main" swap.
  const sell = outgoing.reduce((a, b) => ((a.tokenAmount ?? 0) > (b.tokenAmount ?? 0) ? a : b));
  const buy = incoming.reduce((a, b) => ((a.tokenAmount ?? 0) > (b.tokenAmount ?? 0) ? a : b));
  const sellAmount = sell.tokenAmount ?? 0;
  const buyAmount = buy.tokenAmount ?? 0;
  if (sellAmount <= 0 || buyAmount <= 0) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: { reason: 'zero_amount_leg', sellAmount, buyAmount },
      lockPeriod,
    };
  }

  // Find the USDC side and the priced side.
  const sellIsStable = STABLE_USDC_MINTS.has(sell.mint);
  const buyIsStable = STABLE_USDC_MINTS.has(buy.mint);
  if (sellIsStable === buyIsStable) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'unpriceable_pair',
        note: 'Neither or both legs are a stable USDC mint — cannot price deviation.',
        sellMint: sell.mint,
        buyMint: buy.mint,
      },
      lockPeriod,
    };
  }
  const usdcLeg = sellIsStable ? sell : buy;
  const pricedLeg = sellIsStable ? buy : sell;
  const usdcAmountUi = usdcLeg.tokenAmount ?? 0;
  const pricedAmountUi = pricedLeg.tokenAmount ?? 0;

  const feedKey = PRICE_FEED_FOR_MINT[pricedLeg.mint];
  if (!feedKey) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'no_pyth_feed',
        pricedMint: pricedLeg.mint,
        note: 'No Pyth feed registered for this mint — cannot score deviation.',
      },
      lockPeriod,
    };
  }

  const spot = await pyth.getSpotPrice(feedKey);
  if (spot == null || spot <= 0) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'pyth_unavailable',
        feedKey,
        note: 'Pyth Hermes returned no price; cannot verify without external reference.',
      },
      lockPeriod,
    };
  }

  // Implied price: USDC per unit of priced asset. If the agent was the
  // buyer (paid USDC, received priced token), a high implied price means
  // overpayment (loss). If the agent was the seller, a low implied price
  // means undersell (loss).
  const impliedPrice = usdcAmountUi / pricedAmountUi;
  const deviation = (impliedPrice - spot) / spot;
  const absDeviation = Math.abs(deviation);

  const agentIsBuyer = sellIsStable;
  const lossUsdcUi = agentIsBuyer
    ? Math.max(0, (impliedPrice - spot) * pricedAmountUi) // overpaid
    : Math.max(0, (spot - impliedPrice) * pricedAmountUi); // undersold

  if (absDeviation < DEVIATION_THRESHOLD || lossUsdcUi <= 0) {
    return {
      verified: false,
      lossAmount: 0,
      confidence: 0,
      details: {
        reason: 'deviation_below_threshold',
        deviation,
        threshold: DEVIATION_THRESHOLD,
        impliedPrice,
        spotPrice: spot,
        feedKey,
      },
      lockPeriod,
    };
  }

  // Confidence scales with deviation magnitude — 3% → 0.6, 10% → 0.9.
  const confidence = Math.min(0.9, 0.6 + (absDeviation - DEVIATION_THRESHOLD) * 4.29);
  const lossAmount = capToCoverage(uiToRaw(lossUsdcUi), coverageRaw);

  return {
    verified: lossAmount > 0,
    lossAmount,
    confidence: lossAmount > 0 ? confidence : 0,
    details: {
      reason: 'price_deviation',
      deviation,
      impliedPrice,
      spotPrice: spot,
      feedKey,
      agentRole: agentIsBuyer ? 'buyer' : 'seller',
      lossUsdcUi,
    },
    lockPeriod,
  };
}
