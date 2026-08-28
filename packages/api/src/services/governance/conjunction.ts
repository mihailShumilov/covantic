import type { BalanceReading } from '../exploit/baseline.js';
import type { BalanceBaseline } from '../exploit/prefilter.js';
import type { NetDelta } from '../oracle/execution.js';
import type { LegValuation, ValuationContext, ValuationFailure } from '../oracle/valuation.js';
import { valueLegs } from '../oracle/valuation.js';

/**
 * What a takeover actually cost, and whether it happened when the policy says
 * it counts.
 *
 * This is the trigger's own definition — "admin key change **+ drain within
 * 30m**" — and nothing in the codebase computed it before. The verifier never
 * looked at a window, never correlated a control change with an outflow, and
 * paid a flat half of coverage instead of measuring anything.
 *
 * ---
 *
 * **The definition, chosen once so the three shapes do not each need their
 * own arithmetic.** A governance loss is:
 *
 *     what the agent controlled before  −  what it still controls and can use
 *
 * That single subtraction covers all of them:
 *
 *   - **Drained.** The value left. It is in `before` and not in `now`.
 *   - **Seized.** The account stopped being the agent's, so it drops out of
 *     an owner-scoped balance read on its own. Also in `before` and not in
 *     `now` — no special case needed.
 *   - **Frozen.** Still owned, still counted in `now`, and completely
 *     unusable. Subtracted explicitly, because this is the shape every
 *     value-based measurement in the system is blind to: the balance never
 *     moves, so the exploit path reads a zero position delta and rejects it
 *     as `no_net_loss`.
 *
 * **The two halves cannot double-count**, which matters because that is the
 * obvious way to get this wrong. `gone` is what is missing from the current
 * holdings; `frozen` is a subset of what is *present* in them. An account
 * cannot be in both.
 *
 * **What this is not.** It does not attribute the loss to a particular
 * transaction. Two balance readings bound an interval, not an instant, so
 * {@link GovernanceExposure.withinWindow} is a statement about the interval
 * being inside the covered window — not proof that the takeover caused what
 * happened in it. The adjudicator treats it as corroboration and the chain
 * bounds the payout independently.
 */

/**
 * How long after a takeover a loss still counts as part of it.
 *
 * The 30 minutes the coverage table has advertised since launch. Worth being
 * honest about what it is: a patient attacker waits thirty-one minutes. Its
 * job is to bound the *provable* conjunction — a loss outside it is not
 * denied, it goes to a reviewer.
 */
export const GOVERNANCE_DRAIN_WINDOW_SEC = 30 * 60;

/**
 * How far *before* the takeover a baseline reading may sit and still describe
 * the "before". Matches the balance snapshot cadence with room for a missed
 * tick; beyond it the reading describes a different situation.
 */
export const GOVERNANCE_BASELINE_MAX_LEAD_SEC = 30 * 60;

export type ExposureShape = 'drain' | 'freeze' | 'mixed' | 'none';

export interface GovernanceExposure {
  shape: ExposureShape;
  /** Held before the takeover, not held now. */
  gone: LegValuation[];
  /** Held now, and unusable. */
  frozen: LegValuation[];
  goneValueUsd: number;
  frozenValueUsd: number;
  /** `gone + frozen`. Disjoint by construction — see the module note. */
  exposureUsd: number;
  /** Summed reference uncertainty across both, USD. */
  confUsd: number;

  /** Value the agent controlled before, when it could be priced. */
  preIncidentValueUsd: number | null;
  /** `exposureUsd / preIncidentValueUsd`. Null rather than zero when
   *  unevaluated: an absent baseline must not read as "nothing was lost". */
  exposureRatio: number | null;

  measuredFromBlockTime: number | null;
  measuredToBlockTime: number;
  takeoverBlockTime: number;
  windowSec: number;
  /** The measured interval sits inside the covered window. */
  withinWindow: boolean;

  unevaluated: Array<{ check: string; reason: string }>;
}

export type ExposureOutcome =
  | { ok: true; exposure: GovernanceExposure }
  | { ok: false; side: 'gone' | 'frozen' | 'baseline'; failure: ValuationFailure };

export interface ExposureInput {
  /** What the agent held before the takeover. */
  before: BalanceBaseline;
  /** Block time of that reading. Null when no usable baseline exists. */
  beforeBlockTime: number | null;
  /** What the agent holds now. */
  nowHoldings: BalanceReading[];
  /** The subset of `nowHoldings` the agent owns but cannot move. */
  nowFrozen: BalanceReading[];
  nowBlockTime: number;
  takeoverBlockTime: number;
  windowSec?: number;
  ctx: ValuationContext;
}

/**
 * Measure the exposure a takeover created.
 *
 * Fails rather than approximating when either side contains an asset it
 * cannot price, on the same reasoning as {@link ../exploit/loss.ts}: treating
 * an unpriceable holding as worthless is how a fabricated loss gets paid. The
 * caller maps a failure to `indeterminate` and a human looks at it.
 */
export async function assessGovernanceExposure(
  input: ExposureInput,
): Promise<ExposureOutcome> {
  const windowSec = input.windowSec ?? GOVERNANCE_DRAIN_WINDOW_SEC;
  const unevaluated: Array<{ check: string; reason: string }> = [];

  const nowByMint = new Map(input.nowHoldings.map((r) => [r.mint, r]));
  const frozenByMint = new Map(input.nowFrozen.map((r) => [r.mint, r]));

  // --- what is missing ----------------------------------------------------
  const goneDeltas: NetDelta[] = [];
  if (input.before.size === 0) {
    unevaluated.push({
      check: 'pre_takeover_holdings',
      reason:
        'No balance snapshot close enough to the takeover to measure against. Value that ' +
        'left before the claim was filed cannot be sized.',
    });
  }
  for (const [mint, held] of input.before) {
    const nowRaw = nowByMint.get(mint)?.amountRaw ?? 0;
    const missingRaw = held.amountRaw - nowRaw;
    if (missingRaw <= 0) continue;
    goneDeltas.push({
      mint,
      amountUi: missingRaw / 10 ** held.decimals,
      decimals: held.decimals,
    });
  }

  // --- what is present and unusable ---------------------------------------
  const frozenDeltas: NetDelta[] = [...frozenByMint.values()]
    .filter((r) => r.amountRaw > 0)
    .map((r) => ({
      mint: r.mint,
      amountUi: r.amountRaw / 10 ** r.decimals,
      decimals: r.decimals,
    }));

  const goneOutcome = await valueLegs(goneDeltas, input.ctx);
  if (!goneOutcome.ok) return { ok: false, side: 'gone', failure: goneOutcome.failure };

  const frozenOutcome = await valueLegs(frozenDeltas, input.ctx);
  if (!frozenOutcome.ok) return { ok: false, side: 'frozen', failure: frozenOutcome.failure };

  // --- what it was all worth to begin with --------------------------------
  // Softer rule than the two above, deliberately: the baseline only feeds the
  // ratio, so an unpriceable *held* asset costs the ratio, not the verdict.
  const baselineDeltas: NetDelta[] = [...input.before].map(([mint, held]) => ({
    mint,
    amountUi: held.amountRaw / 10 ** held.decimals,
    decimals: held.decimals,
  }));
  const baselineOutcome = await valueLegs(baselineDeltas, input.ctx);
  let preIncidentValueUsd: number | null = null;
  if (baselineOutcome.ok) {
    preIncidentValueUsd = sum(baselineOutcome.legs, (l) => l.valueUsd);
  } else {
    unevaluated.push({
      check: 'pre_incident_valuation',
      reason: `Held position could not be priced (${baselineOutcome.failure.kind}); exposure ratio unevaluated.`,
    });
  }

  const goneValueUsd = sum(goneOutcome.legs, (l) => l.valueUsd);
  const frozenValueUsd = sum(frozenOutcome.legs, (l) => l.valueUsd);
  const exposureUsd = goneValueUsd + frozenValueUsd;

  // --- when ---------------------------------------------------------------
  const withinWindow = isWithinWindow(input, windowSec, unevaluated);

  return {
    ok: true,
    exposure: {
      shape: shapeOf(goneValueUsd, frozenValueUsd),
      gone: goneOutcome.legs,
      frozen: frozenOutcome.legs,
      goneValueUsd,
      frozenValueUsd,
      exposureUsd,
      confUsd:
        sum(goneOutcome.legs, (l) => l.confUsd) + sum(frozenOutcome.legs, (l) => l.confUsd),
      preIncidentValueUsd,
      exposureRatio:
        preIncidentValueUsd !== null && preIncidentValueUsd > 0
          ? exposureUsd / preIncidentValueUsd
          : null,
      measuredFromBlockTime: input.beforeBlockTime,
      measuredToBlockTime: input.nowBlockTime,
      takeoverBlockTime: input.takeoverBlockTime,
      windowSec,
      withinWindow,
      unevaluated,
    },
  };
}

/**
 * Does the measured interval sit inside the covered window?
 *
 * Both ends have to hold. A baseline from long before the takeover would
 * attribute an earlier, unrelated loss to it; a current reading long after
 * would sweep in everything that happened since. Neither is denied when it
 * fails — the adjudicator drops it to review — but neither may be presented
 * as a proven conjunction either.
 */
function isWithinWindow(
  input: ExposureInput,
  windowSec: number,
  unevaluated: Array<{ check: string; reason: string }>,
): boolean {
  if (input.beforeBlockTime === null) return false;

  const lead = input.takeoverBlockTime - input.beforeBlockTime;
  const lag = input.nowBlockTime - input.takeoverBlockTime;

  if (lead < 0) {
    unevaluated.push({
      check: 'window_conjunction',
      reason: 'The baseline reading postdates the takeover; it describes the aftermath.',
    });
    return false;
  }
  if (lead > GOVERNANCE_BASELINE_MAX_LEAD_SEC) {
    unevaluated.push({
      check: 'window_conjunction',
      reason: `Baseline sits ${lead}s before the takeover, beyond the ${GOVERNANCE_BASELINE_MAX_LEAD_SEC}s lead a "before" may have.`,
    });
    return false;
  }
  if (lag > windowSec) {
    unevaluated.push({
      check: 'window_conjunction',
      reason:
        `Holdings were read ${lag}s after the takeover, beyond the ${windowSec}s window. ` +
        'The loss may be real and may still be the takeover’s doing — it is simply not ' +
        'provable as a conjunction from two readings this far apart.',
    });
    return false;
  }
  return true;
}

function shapeOf(goneValueUsd: number, frozenValueUsd: number): ExposureShape {
  if (goneValueUsd > 0 && frozenValueUsd > 0) return 'mixed';
  if (goneValueUsd > 0) return 'drain';
  if (frozenValueUsd > 0) return 'freeze';
  return 'none';
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
