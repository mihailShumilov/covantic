import { MAX_ENVELOPE_SURCHARGE_BPS } from '@covantic/shared';

/**
 * What a declared deductible costs on top of the tier premium.
 *
 * The tier prices *who the agent is*. This prices *what the holder said the
 * agent may do* — and until it existed, that half was free.
 *
 * A holder chose the envelope after the premium was fixed, so they could
 * declare a cap their agent was certain to cross, move money to an address the
 * verifier has no way to attribute to them, and collect the overshoot. The
 * movement is real and the loss is not; `isSelf` knows only the holder and
 * agent wallets, and a fresh address reads as foreign. Nothing in the
 * protocol stopped it, because the deductible was never priced.
 *
 * ## What is being measured
 *
 * Not the size of the cap — a cap means nothing without the behaviour it
 * bounds. What matters is **headroom**: how far the declared limit sits above
 * what the agent normally does. An agent whose typical movement is 20 USDC
 * with a 100 USDC cap has to behave five times abnormally before the vault
 * owes anything, and a breach there is genuinely an anomaly. The same 100 USDC
 * cap on an agent that routinely moves 600 is not a deductible at all; it is a
 * standing instruction to pay.
 *
 * This is what an underwriter does with a claims history, and it is the reason
 * the surcharge is computed here rather than on chain: the agent's outflow
 * record is off-chain data the program cannot see. The oracle prices it and
 * signs for the number, and `create_policy` applies it.
 *
 * ## The shape of the curve, and its honesty
 *
 * Linear between the two thresholds. The real probability of breach is not
 * linear in headroom, and pretending otherwise would be false precision — this
 * is a bound chosen to make the extraction unprofitable, not an estimate of
 * anything. The numbers below are the tunable part; the structure is not.
 */

/** Headroom at or above which the envelope costs nothing extra. */
export const FREE_HEADROOM = 5;

/**
 * Headroom below which the oracle declines to attest at all.
 *
 * Under one, the agent's ordinary business already crosses the cap. There is
 * no premium that prices that correctly, because it is not insurance — the
 * claim is scheduled. Refusing is the honest answer, and it happens at the
 * quote, where the holder can widen the envelope, rather than at purchase.
 */
export const MIN_HEADROOM = 1;

export type EnvelopePricing =
  | { kind: 'priced'; surchargeBps: number; headroom: number; basis: 'history' }
  /** No history to measure against; charged the ceiling. */
  | { kind: 'priced'; surchargeBps: number; headroom: null; basis: 'no_history' }
  | { kind: 'refused'; reason: string; headroom: number };

export interface EnvelopePricingInput {
  /** The declared single-outflow cap, raw base units. */
  maxSingleOutflowRaw: number;
  /** The declared retention floor, raw. Zero means undeclared. */
  minRetainedBalanceRaw: number;
  /** What the agent holds now, raw. */
  coveredBalanceRaw: number;
  /**
   * The agent's own 95th-percentile movement, raw, or null when there is no
   * usable history. Null is not zero: zero would read as infinite headroom and
   * price a brand-new agent as the safest possible risk.
   */
  p95OutflowRaw: number | null;
  /** How many movements the percentile was computed from. */
  transferCount: number;
}

/** Below this the distribution says nothing, whatever it computes. */
export const MIN_OBSERVATIONS_TO_PRICE = 5;

function surchargeFor(headroom: number): number {
  if (headroom >= FREE_HEADROOM) return 0;
  const tightness = (FREE_HEADROOM - headroom) / (FREE_HEADROOM - MIN_HEADROOM);
  return Math.round(Math.min(1, Math.max(0, tightness)) * MAX_ENVELOPE_SURCHARGE_BPS);
}

export function priceEnvelope(input: EnvelopePricingInput): EnvelopePricing {
  const { p95OutflowRaw, transferCount } = input;

  if (p95OutflowRaw === null || p95OutflowRaw <= 0 || transferCount < MIN_OBSERVATIONS_TO_PRICE) {
    // The ceiling, not a refusal. A new agent is not a bad risk, it is an
    // unmeasured one, and refusing would make the product unbuyable on day
    // one. Charging the most it could cost leaves the holder the option of
    // building a record and quoting again.
    return { kind: 'priced', surchargeBps: MAX_ENVELOPE_SURCHARGE_BPS, headroom: null, basis: 'no_history' };
  }

  // Both declared dimensions are deductibles, and the tighter one governs.
  //
  // The floor is the one that reads as generous and is not: a floor just below
  // the current balance means the very next ordinary movement breaches it,
  // exactly like a cap just below the usual transfer size.
  const capHeadroom = input.maxSingleOutflowRaw / p95OutflowRaw;
  const floorRoom = Math.max(0, input.coveredBalanceRaw - input.minRetainedBalanceRaw);
  const floorHeadroom =
    input.minRetainedBalanceRaw > 0 ? floorRoom / p95OutflowRaw : Number.POSITIVE_INFINITY;
  const headroom = Math.min(capHeadroom, floorHeadroom);

  if (headroom < MIN_HEADROOM) {
    return {
      kind: 'refused',
      reason:
        capHeadroom <= floorHeadroom
          ? 'declared_cap_below_agent_normal_movement'
          : 'declared_floor_leaves_no_room_for_normal_movement',
      headroom: Number(headroom.toFixed(3)),
    };
  }

  return {
    kind: 'priced',
    surchargeBps: surchargeFor(headroom),
    headroom: Number(headroom.toFixed(3)),
    basis: 'history',
  };
}
