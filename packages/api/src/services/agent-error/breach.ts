import type { MandateView } from './types.js';

/**
 * Where a movement fell against the envelope the holder declared.
 *
 * Pure. No I/O, no clock, no randomness — this is a comparison of numbers and
 * sets, and it is separated from the evidence gathering for the same reason
 * the adjudicators are: it has to produce the same answer forever, for anyone
 * holding the bundle.
 *
 * ---
 *
 * **The split that runs through this whole module.** Two of the five
 * dimensions can be re-derived on chain at settlement, and three cannot.
 *
 * The program can read the covered token account's balance now and compare it
 * against a checkpoint it wrote earlier. That gives it the drop, so it can
 * check the single-outflow cap and the retention floor for itself. It cannot
 * inspect a *past* transaction, so it can see neither where the money went nor
 * what it was routed through, and it holds one balance reading per policy
 * rather than a window of them, so it cannot sum a rolling total either.
 *
 * That is not a gap to be papered over. `verify_and_payout_agent_error`
 * settles only breaches it can measure, and a breach of the categorical
 * dimensions alone goes to a reviewer instead of being paid on an assertion
 * the chain cannot check. {@link MandateBreachReport.provable} is what carries
 * that distinction to the settlement planner.
 */

export type BreachDimensionName =
  | 'single_outflow'
  | 'window_outflow'
  | 'retained_balance'
  | 'counterparty'
  | 'program';

export interface BreachDimension {
  dimension: BreachDimensionName;
  /** Quantitative dimensions have an overshoot; categorical ones do not. */
  kind: 'quantitative' | 'categorical';
  /** What the holder declared. A number for quantitative dimensions, the
   *  declared set for categorical ones. */
  declared: number | string[];
  observed: number | string[];
  /** How far outside the envelope, in raw base units. Zero for categorical. */
  excessRaw: number;
  /** Whether `verify_and_payout_agent_error` can re-derive this for itself. */
  chainCheckable: boolean;
}

export interface MandateBreachReport {
  breached: boolean;
  dimensions: BreachDimension[];
  /**
   * The largest **chain-checkable** overshoot, raw base units.
   *
   * Deliberately not the largest overshoot of any kind. This number is the
   * bound a proven payout is capped at, and the program will recompute it; a
   * value derived from a dimension the chain cannot see would simply make the
   * settlement transaction revert.
   */
  excessRaw: number;
  /** At least one breached dimension is one the chain can re-derive. */
  provable: boolean;
  /** Checks that could not run, with why. Never conflated with "passed" —
   *  an unevaluated counterparty check is a hole in the picture. */
  unevaluated: Array<{ check: string; reason: string }>;
}

export interface BreachInput {
  mandate: MandateView;
  /** Net outflow of the covered mint, raw base units, positive. */
  outflowRaw: number;
  /** Covered-mint balance after the transaction, raw. Null when the evidence
   *  shape carried deltas only and the absolute balance is unknown. */
  retainedRaw: number | null;
  /** Cumulative outflow across the mandate's window, including this movement.
   *  Null when no history was available. */
  windowOutflowRaw: number | null;
  /** Where the value went, excluding anything the family controls. */
  destinations: string[];
  /** Programs the value was routed through. */
  programs: string[];
}

/**
 * Score a movement against a declared mandate.
 *
 * Silence in the mandate is not prohibition. An empty allowlist means the
 * holder said nothing about that dimension, so it is reported as unevaluated
 * rather than breached — treating a blank field as "nothing is permitted"
 * would make every ordinary transfer a covered event, which is the retired
 * verifier's failure mode reached from the opposite direction.
 */
export function evaluateBreach(input: BreachInput): MandateBreachReport {
  const { mandate } = input;
  const dimensions: BreachDimension[] = [];
  const unevaluated: Array<{ check: string; reason: string }> = [];

  // --- single-outflow cap (chain-checkable) --------------------------------
  if (mandate.maxSingleOutflowRaw > 0) {
    const excess = Math.max(0, input.outflowRaw - mandate.maxSingleOutflowRaw);
    if (excess > 0) {
      dimensions.push({
        dimension: 'single_outflow',
        kind: 'quantitative',
        declared: mandate.maxSingleOutflowRaw,
        observed: input.outflowRaw,
        excessRaw: excess,
        chainCheckable: true,
      });
    }
  } else {
    // The declare instruction rejects a zero cap, so this is a mandate that
    // reached the account some other way — or a mirror that failed to decode.
    unevaluated.push({
      check: 'single_outflow',
      reason: 'mandate declares no single-outflow cap',
    });
  }

  // --- retention floor (chain-checkable) -----------------------------------
  if (mandate.minRetainedBalanceRaw > 0) {
    if (input.retainedRaw === null) {
      unevaluated.push({
        check: 'retained_balance',
        reason: 'evidence carried deltas only; the absolute balance is unknown',
      });
    } else {
      // Clamped to the outflow: value that left before this movement is not
      // something this claim may reach back for. The program applies the same
      // clamp against the measured drop, and the two must not disagree about
      // what the movement cost.
      const excess = Math.min(
        Math.max(0, mandate.minRetainedBalanceRaw - input.retainedRaw),
        Math.max(0, input.outflowRaw),
      );
      if (excess > 0) {
        dimensions.push({
          dimension: 'retained_balance',
          kind: 'quantitative',
          declared: mandate.minRetainedBalanceRaw,
          observed: input.retainedRaw,
          excessRaw: excess,
          chainCheckable: true,
        });
      }
    }
  }

  // --- rolling window cap (off-chain only) ---------------------------------
  // The program holds one balance reading per policy, not a window of
  // transfers, so it cannot sum this for itself.
  if (mandate.maxWindowOutflowRaw > 0 && mandate.windowSeconds > 0) {
    if (input.windowOutflowRaw === null) {
      unevaluated.push({
        check: 'window_outflow',
        reason: 'no outflow history available for the mandate window',
      });
    } else {
      const excess = Math.max(0, input.windowOutflowRaw - mandate.maxWindowOutflowRaw);
      if (excess > 0) {
        dimensions.push({
          dimension: 'window_outflow',
          kind: 'quantitative',
          declared: mandate.maxWindowOutflowRaw,
          observed: input.windowOutflowRaw,
          excessRaw: excess,
          chainCheckable: false,
        });
      }
    }
  }

  // --- destination allowlist (off-chain only) ------------------------------
  if (mandate.allowedCounterparties.length === 0) {
    unevaluated.push({
      check: 'counterparty',
      reason: 'mandate declares no counterparty allowlist — silence, not prohibition',
    });
  } else if (input.destinations.length === 0) {
    unevaluated.push({
      check: 'counterparty',
      reason: 'no destinations resolved from the evidence',
    });
  } else {
    const permitted = new Set(mandate.allowedCounterparties);
    const undeclared = input.destinations.filter((d) => !permitted.has(d));
    if (undeclared.length > 0) {
      dimensions.push({
        dimension: 'counterparty',
        kind: 'categorical',
        declared: mandate.allowedCounterparties,
        observed: undeclared,
        excessRaw: 0,
        chainCheckable: false,
      });
    }
  }

  // --- program allowlist (off-chain only) ----------------------------------
  if (mandate.allowedPrograms.length === 0) {
    unevaluated.push({
      check: 'program',
      reason: 'mandate declares no program allowlist — silence, not prohibition',
    });
  } else if (input.programs.length === 0) {
    unevaluated.push({
      check: 'program',
      reason: 'no programs resolved from the evidence',
    });
  } else {
    const permitted = new Set(mandate.allowedPrograms);
    const undeclared = input.programs.filter((p) => !permitted.has(p));
    if (undeclared.length > 0) {
      dimensions.push({
        dimension: 'program',
        kind: 'categorical',
        declared: mandate.allowedPrograms,
        observed: undeclared,
        excessRaw: 0,
        chainCheckable: false,
      });
    }
  }

  const chainCheckable = dimensions.filter((d) => d.chainCheckable);
  return {
    breached: dimensions.length > 0,
    dimensions,
    excessRaw: chainCheckable.reduce((max, d) => Math.max(max, d.excessRaw), 0),
    provable: chainCheckable.length > 0,
    unevaluated,
  };
}
