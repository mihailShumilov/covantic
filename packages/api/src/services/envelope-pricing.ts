
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
 * ## Two questions, and the answer is the worse of them
 *
 * Headroom asks whether a breach is *likely* — will this agent, behaving as it
 * has been, cross the line by accident. That needs a history, and a new agent
 * has none.
 *
 * The second question needs no history at all: how much can the holder extract
 * *on purpose*, right now, if they choose to? That is arithmetic on the
 * balance. An agent holding 5,000 with a 100 cap can be walked over the line
 * for 4,900, bounded by the coverage — the whole policy, collectable at will.
 * The same agent with a 1,000,000 cap cannot cross it at all, whatever its
 * habits, because it does not hold that much.
 *
 * Charging that amount **flat** is what makes the manoeuvre pointless: extract
 * the whole coverage and you have paid the whole coverage for the privilege.
 * It also prices a brand-new agent honestly, where charging a ceiling for want
 * of a history charged an unmeasured agent as though it were a hostile one.
 *
 * Flat, and not a rate, because the arithmetic said so. The ability exists
 * from the first minute of the policy; a rate divides it by the tenor. A
 * one-hour policy cost 0.23 USDC for an ability worth up to the full 2,000
 * coverage, and no duration the program allows was long enough to close the
 * gap — break-even sat at 356 days against a 30-day maximum, and raising the
 * rate instead would have overflowed the `u16` the attestation carried it in.
 *
 * The surcharge is the **larger** of the two. A holder pays for whichever is
 * worse: the chance their agent breaches by accident, or the amount they could
 * take deliberately.
 *
 * ## The shape of the curve, and its honesty
 *
 * The headroom half is linear between its two thresholds. The real probability
 * of breach is not linear in headroom, and pretending otherwise would be false
 * precision — that half is a bound chosen to make the manoeuvre unprofitable,
 * not an estimate of anything. The extractable half is not a model at all; it
 * is a measurement.
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
  | { kind: 'priced'; flatPremiumRaw: number; headroom: number; basis: 'history' }
  /** No history yet; priced on what the balance lets the holder extract. */
  | { kind: 'priced'; flatPremiumRaw: number; headroom: null; basis: 'balance' }
  | { kind: 'refused'; reason: string; headroom: number };

export interface EnvelopePricingInput {
  /** What the policy would pay at most, raw. The extractable amount is
   *  bounded by it, so it is what the surcharge is a fraction of. */
  coverageAmountRaw: number;
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

/**
 * What the holder can take at will, given what the agent holds today.
 *
 * The cap is crossed by moving more than it, and the most that can be moved is
 * the balance — so the overshoot available is `balance - cap`, or nothing when
 * the cap is out of reach. The floor is crossed by moving enough to fall under
 * it, and moving everything makes the shortfall the whole floor.
 *
 * Whichever is larger, bounded by the coverage: a single movement triggers one
 * of them, and the policy cannot pay more than it covers.
 *
 * That last bound is arithmetically redundant with the clamp in
 * `extractableSurcharge` — a mutation run proved it, by removing it and
 * failing nothing. It stays because this function is named for a quantity, and
 * the quantity is false without it: what a holder can *take* is capped by the
 * policy whether or not the caller divides by it afterwards.
 */
function extractableRaw(input: EnvelopePricingInput): number {
  const viaCap = Math.max(0, input.coveredBalanceRaw - input.maxSingleOutflowRaw);
  const viaFloor = Math.min(input.minRetainedBalanceRaw, input.coveredBalanceRaw);
  return Math.min(input.coverageAmountRaw, Math.max(viaCap, viaFloor));
}

/**
 * The habit half, expressed as an amount rather than a rate.
 *
 * A tight envelope on an agent whose ordinary movements sit just under it will
 * be breached in normal operation, and the vault owes the overshoot when it
 * is. That is a real risk rather than a manoeuvre, so it is priced as a
 * fraction of the coverage — but it is charged flat for the same reason the
 * extractable half is: the breach can happen on the first day.
 */
function habitPremiumRaw(headroom: number, coverageAmountRaw: number): number {
  if (headroom >= FREE_HEADROOM) return 0;
  const tightness = (FREE_HEADROOM - headroom) / (FREE_HEADROOM - MIN_HEADROOM);
  return Math.round(Math.min(1, Math.max(0, tightness)) * coverageAmountRaw);
}

export function priceEnvelope(input: EnvelopePricingInput): EnvelopePricing {
  const { p95OutflowRaw, transferCount } = input;

  const extractable = extractableRaw(input);

  if (p95OutflowRaw === null || p95OutflowRaw <= 0 || transferCount < MIN_OBSERVATIONS_TO_PRICE) {
    // No history is not a reason to charge a ceiling. What the holder can take
    // at will is measurable without one, and an envelope the agent cannot
    // cross with the balance it holds carries no exposure however new it is.
    return { kind: 'priced', flatPremiumRaw: extractable, headroom: null, basis: 'balance' };
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

  // The worse of the two. Habits do not excuse an envelope that can be walked
  // over deliberately, and an unreachable cap does not excuse an agent whose
  // ordinary movements sit right under it.
  return {
    kind: 'priced',
    flatPremiumRaw: Math.max(habitPremiumRaw(headroom, input.coverageAmountRaw), extractable),
    headroom: Number(headroom.toFixed(3)),
    basis: 'history',
  };
}
