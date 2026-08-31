import { canonicalMint, lookupMint } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';
import { positionFromEnhanced, positionFromRawTx } from '../exploit/position.js';
import type { RawTxView } from '../exploit/raw-tx.js';
import type { MandateView, OutflowBaselineView } from './types.js';

/**
 * Cheap screen for transactions worth a full agent-error verification.
 *
 * What it replaces is the reason it exists. `TransactionMonitor` raised
 * `large_transfer` when the summed `tokenAmount` of every outgoing transfer
 * crossed 1,000 — **with no reference to the mint**. The threshold was reasoned
 * about as dollars and compared against a count of tokens, so 1,001 units of a
 * worthless airdrop tripped it and 0.4 WBTC did not. It also raised `failed_tx`
 * on any reverted transaction, which opened a claim for a few thousand lamports
 * of fees and, because `review` is an open status, blocked every subsequent
 * claim on that policy — including a genuine exploit.
 *
 * The failure direction here is the same as every other screen in the system:
 *
 *   **Detection fails open; settlement fails closed.**
 *
 * A false alarm costs one verification. A miss costs the policyholder their
 * claim, permanently and silently. So a mandate that cannot be read, or a mint
 * that cannot be priced, produces a flag carrying an `unevaluated` marker
 * rather than silence — the verifier has retries, an indeterminate lane and an
 * evidence bundle, and is the right place for the careful work.
 *
 * Three signals, in descending order of what they justify:
 *
 * 1. **Mandate-relative.** The movement fell outside an envelope the holder
 *    declared. This is the covered event; everything else is a heuristic that
 *    decides what is worth a look.
 * 2. **History-relative.** The movement is far outside what this agent
 *    normally does — the "transfer >100x agent average" the product has
 *    advertised since launch, implemented here for the first time.
 * 3. **Value floor.** A large movement in dollars, for agents with neither a
 *    mandate nor usable history. This is the repaired version of the old
 *    threshold: valued per mint rather than summed across them.
 */

/**
 * How far past the agent's own p95 payment is worth a look.
 *
 * The coverage table says "100x average". This screens against the p95 rather
 * than the mean because a mean is dragged by exactly the outliers being looked
 * for — one runaway payment last week raises the bar against the next one.
 */
export const OUTFLOW_RATIO_THRESHOLD = 100;

/**
 * Absolute floor in USD-equivalent UI units, for when there is nothing to
 * compare against.
 *
 * Same number as the threshold it replaces, and deliberately so — but applied
 * to a *valued* outflow of a registered mint rather than to a sum of token
 * counts, which is the whole of the repair.
 */
export const SCREEN_MIN_VALUE_UI = 1_000;

export interface AgentErrorScreenResult {
  flagged: boolean;
  severity: 'warning' | 'critical';
  reason: string;
  detail: Record<string, unknown>;
}

const NOT_FLAGGED: AgentErrorScreenResult = {
  flagged: false,
  severity: 'warning',
  reason: 'no_agent_error_shape',
  detail: {},
};

export interface AgentErrorScreenOptions {
  /** The declared envelope, when one could be read. `null` means the lookup
   *  ran and found nothing; `undefined` means it never ran. */
  mandate?: MandateView | null;
  /** The agent's own spending history, same null/undefined distinction. */
  outflowBaseline?: OutflowBaselineView | null;
  /** Mint the mandate's amounts are denominated in. */
  coveredMint?: string;
}

/**
 * Screen a webhook payload for a movement outside the agent's mandate.
 *
 * Works from the indexer shape alone, which bounds what it can see: no signer
 * flags, no token-account owners, so it cannot tell whether the agent's own
 * authority moved the money. That is the verifier's job and the screen does
 * not pretend to do it — an unauthorised drain flagged here simply resolves to
 * `not_agent_authorized` and gets routed to the trigger it belongs to.
 */
export function screenForMandateBreach(
  tx: EnhancedTransaction,
  agentAddress: string,
  options: AgentErrorScreenOptions = {},
): AgentErrorScreenResult {
  // A reverted transaction moved nothing. Its cost is fees, and fee burn is an
  // operational signal rather than a covered event — the flat invented USDC
  // the old verifier approved for this case is exactly what this early return
  // exists to prevent recurring.
  if (tx.transactionError) return NOT_FLAGGED;

  return decideMandateBreach(outflowsByMint(tx, agentAddress), options);
}

/**
 * The same screen, over the chain's own record of the transaction.
 *
 * Detection for this trigger used to exist on the webhook path alone: nothing
 * but `POST /api/monitoring/webhook` ever reached `screenForMandateBreach`. So
 * the trigger the protocol's autonomy rests on — the one a holder can
 * legitimately stage, because it is measured against their own declaration —
 * was the one trigger that stopped being detected the moment a third party's
 * delivery stopped. Exploit and governance already had `screenRawTx*` twins
 * running on the sweep; this is the missing third.
 *
 * `RawTxView` is the stronger shape, not a fallback: it carries each token
 * account's owner on both sides of the transaction, so the retention floor is
 * compared against a balance actually read rather than reported as
 * unevaluated.
 */
export function screenRawTxForMandateBreach(
  view: RawTxView,
  agentAddress: string,
  options: AgentErrorScreenOptions = {},
): AgentErrorScreenResult {
  if (view.err) return NOT_FLAGGED;

  return decideMandateBreach(outflowsFromRawTx(view, agentAddress), options);
}

/**
 * The verdict, given what left the agent.
 *
 * Shared so the two entry points cannot drift: a screen that fires on the
 * webhook path and stays silent on the sweep would make detection depend on
 * which one happened to see the transaction first.
 */
function decideMandateBreach(
  outgoing: MintOutflow[],
  options: AgentErrorScreenOptions,
): AgentErrorScreenResult {
  const coveredMint = options.coveredMint ? canonicalMint(options.coveredMint) : null;
  if (outgoing.length === 0) return NOT_FLAGGED;

  const coveredLeg = coveredMint
    ? outgoing.find((leg) => canonicalMint(leg.mint) === coveredMint)
    : undefined;
  const coveredOutflowRaw = coveredLeg ? coveredLeg.outflowRaw : 0;

  // --- 1. mandate-relative -------------------------------------------------
  const mandate = options.mandate;
  if (mandate && coveredLeg) {
    const overCap =
      mandate.maxSingleOutflowRaw > 0 && coveredOutflowRaw > mandate.maxSingleOutflowRaw;
    const underFloor =
      mandate.minRetainedBalanceRaw > 0 &&
      coveredLeg.retainedRaw !== null &&
      coveredLeg.retainedRaw < mandate.minRetainedBalanceRaw;
    const overWindow =
      mandate.maxWindowOutflowRaw > 0 &&
      options.outflowBaseline != null &&
      !options.outflowBaseline.stale &&
      options.outflowBaseline.windowOutflowRaw + coveredOutflowRaw >
        mandate.maxWindowOutflowRaw;

    if (overCap || underFloor || overWindow) {
      return {
        flagged: true,
        severity: 'critical',
        reason: 'mandate_envelope_exceeded',
        detail: {
          outflowRaw: coveredOutflowRaw,
          retainedRaw: coveredLeg.retainedRaw,
          declaredMaxSingleOutflowRaw: mandate.maxSingleOutflowRaw,
          declaredMinRetainedBalanceRaw: mandate.minRetainedBalanceRaw,
          declaredMaxWindowOutflowRaw: mandate.maxWindowOutflowRaw,
          dimensions: [
            overCap ? 'single_outflow' : null,
            underFloor ? 'retained_balance' : null,
            overWindow ? 'window_outflow' : null,
          ].filter(Boolean),
        },
      };
    }
  }

  // --- 2. history-relative -------------------------------------------------
  const baseline = options.outflowBaseline;
  if (baseline && !baseline.stale && baseline.p95OutflowRaw > 0 && coveredOutflowRaw > 0) {
    const ratio = coveredOutflowRaw / baseline.p95OutflowRaw;
    if (ratio >= OUTFLOW_RATIO_THRESHOLD) {
      return {
        flagged: true,
        severity: 'critical',
        reason: 'outflow_far_above_agent_history',
        detail: {
          outflowRaw: coveredOutflowRaw,
          p95OutflowRaw: baseline.p95OutflowRaw,
          ratio: Number(ratio.toFixed(2)),
          threshold: OUTFLOW_RATIO_THRESHOLD,
          transferCount: baseline.transferCount,
          // Named so a reviewer knows this fired without a declaration to
          // measure against, and will therefore resolve to review.
          mandateDeclared: mandate != null,
        },
      };
    }
  }

  // --- 3. value floor ------------------------------------------------------
  // Per registered mint, valued at par in its own units — not summed across
  // mints. An unregistered mint has no meaningful UI value here, so it is
  // reported as unevaluated rather than counted as zero.
  const unpriceable: string[] = [];
  let largestUi = 0;
  let largestMint: string | null = null;
  for (const leg of outgoing) {
    if (!leg.registered) {
      unpriceable.push(leg.mint);
      continue;
    }
    if (leg.outflowUi > largestUi) {
      largestUi = leg.outflowUi;
      largestMint = leg.mint;
    }
  }

  if (largestUi >= SCREEN_MIN_VALUE_UI) {
    return {
      flagged: true,
      severity: largestUi >= SCREEN_MIN_VALUE_UI * 10 ? 'critical' : 'warning',
      reason: 'large_valued_outflow',
      detail: {
        mint: largestMint,
        outflowUi: largestUi,
        threshold: SCREEN_MIN_VALUE_UI,
        unpriceableMints: unpriceable,
        mandateDeclared: mandate != null,
        note:
          'Screened on the value of a single registered mint. The retired threshold summed ' +
          'raw token counts across every mint, which fired on junk airdrops and missed ' +
          'high-value, low-count assets.',
      },
    };
  }

  if (unpriceable.length > 0) {
    // Fails open: a mint the registry does not know may still have been the
    // whole loss, and silence here would make it invisible.
    return {
      flagged: true,
      severity: 'warning',
      reason: 'unpriceable_outflow',
      detail: {
        unpriceableMints: unpriceable,
        note: 'Value left in a mint with no registry entry; the verifier decides what it was worth.',
      },
    };
  }

  return NOT_FLAGGED;
}

/** One mint's net outflow, in both units the screen needs. */
interface MintOutflow {
  mint: string;
  outflowRaw: number;
  outflowUi: number;
  /** Balance left in the covered account afterwards, raw. Null when only
   *  deltas were available. */
  retainedRaw: number | null;
  /** Whether the registry knows this mint, and therefore whether `outflowUi`
   *  means anything. */
  registered: boolean;
}

/**
 * Net outflow per mint, from whichever shape the payload actually carries.
 *
 * `accountData[].tokenBalanceChanges` is preferred and is the authoritative
 * source: it is a signed delta attributed to an owner, so an ordinary swap —
 * value out of one leg, back into another — nets rather than reading as a
 * loss. Preferring it is also what gives the retention floor an absolute
 * balance to compare against.
 *
 * `tokenTransfers[]` is the fallback, and it exists because detection fails
 * open. A thin payload with no `accountData` is not evidence that nothing
 * moved, and silently returning "no outflow" for one would make a real breach
 * invisible for as long as an indexer served the shorter shape. The fallback
 * cannot net incoming value and has no absolute balances, so a swap can reach
 * the verifier from it — which is the right direction: the verifier reads the
 * chain's own record and rejects it as `within_mandate` or `no_net_loss`.
 */
/**
 * What left the agent, from the chain's own record.
 *
 * No `tokenTransfers` fallback, because there is nothing to fall back *to*:
 * `RawTxView` always carries pre and post balances, and a leg it cannot see
 * is a leg that did not move.
 */
function outflowsFromRawTx(view: RawTxView, agentAddress: string): MintOutflow[] {
  return positionFromRawTx(view, agentAddress)
    .legs.filter((leg) => leg.deltaRaw < 0)
    .map((leg) => describe(leg.mint, Math.abs(leg.deltaRaw), leg.decimals, leg.afterRaw));
}

function outflowsByMint(tx: EnhancedTransaction, agentAddress: string): MintOutflow[] {
  const position = positionFromEnhanced(tx, agentAddress);
  const fromDeltas = position.legs
    .filter((leg) => leg.deltaRaw < 0)
    .map((leg) => describe(leg.mint, Math.abs(leg.deltaRaw), leg.decimals, leg.afterRaw));
  if (fromDeltas.length > 0) return fromDeltas;

  const byMint = new Map<string, number>();
  for (const transfer of tx.tokenTransfers ?? []) {
    if (transfer.fromUserAccount !== agentAddress) continue;
    if (!(transfer.tokenAmount > 0) || !transfer.mint) continue;
    byMint.set(transfer.mint, (byMint.get(transfer.mint) ?? 0) + transfer.tokenAmount);
  }

  return [...byMint].map(([mint, ui]) => {
    const meta = lookupMint(canonicalMint(mint));
    const decimals = meta?.decimals ?? 0;
    return {
      mint,
      outflowRaw: Math.round(ui * 10 ** decimals),
      outflowUi: ui,
      // The shorter shape carries no absolute balances, so the retention floor
      // reports as unevaluated rather than being compared against a guess.
      retainedRaw: null,
      registered: meta !== undefined && meta !== null,
    };
  });
}

function describe(
  mint: string,
  outflowRaw: number,
  decimals: number,
  afterRaw: number | null,
): MintOutflow {
  const meta = lookupMint(canonicalMint(mint));
  return {
    mint,
    outflowRaw,
    outflowUi: outflowRaw / 10 ** decimals,
    retainedRaw: afterRaw,
    registered: meta !== undefined && meta !== null,
  };
}
