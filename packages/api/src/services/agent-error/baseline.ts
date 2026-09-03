import { and, asc, eq, gte, lte, ne } from 'drizzle-orm';
import type { Database } from '../../config/database.js';
import { agentOutflowEvents } from '../../db/schema.js';
import { logger } from '../../utils/logger.js';
import type { OutflowBaselineView } from './types.js';

/**
 * What this agent's spending normally looks like.
 *
 * The coverage table has advertised "transfer >100x agent average" since
 * launch, and until this module nothing computed an average of anything.
 * `agent_balance_snapshots` records *holdings*, and a history of holdings
 * cannot answer what a normal payment looks like — an agent that holds a
 * steady 50,000 USDC and pays out 200 at a time has the same balance history
 * as one that pays out 20,000 at a time.
 *
 * Two consumers: the detection screen, which uses the ratio to decide what is
 * worth verifying, and the adjudicator's confidence score, where a movement
 * far outside what this agent normally does corroborates a mandate breach.
 *
 * It is deliberately **not** a verdict input on its own. "Unusual for this
 * agent" is a reason to look, not a reason to pay: an agent that changes
 * strategy has not made an error, and the only thing that makes a movement a
 * covered event is the holder's own declaration.
 */

/**
 * Beyond this the history describes a different week.
 *
 * Same shape and same reasoning as `BASELINE_MAX_AGE_SEC` on the balance path:
 * past the bound the ratio is reported as **unevaluated**, never as absent and
 * never as zero. A stale baseline that read as zero would make every transfer
 * infinitely unusual.
 */
export const OUTFLOW_BASELINE_MAX_AGE_SEC = 24 * 3600;

/** How far back the statistics are computed over when no window is given. */
export const DEFAULT_OUTFLOW_WINDOW_SEC = 7 * 24 * 3600;

/** Minimum observations before the distribution means anything. */
export const MIN_OUTFLOW_OBSERVATIONS = 5;

export interface OutflowObservation {
  agentAddress: string;
  txSignature: string;
  mint: string;
  amountRaw: number;
  decimals: number;
  blockTime: Date;
}

/**
 * Record what left an agent, once.
 *
 * Both the webhook monitor and the watcher sweep call this, so the write is
 * idempotent on `(agent, signature, mint)`: the same transaction reaching the
 * table twice would double every sum built on it, and the window cap is a sum.
 *
 * Failures are logged and swallowed. History is context; losing a row narrows
 * the picture but must never be able to stop detection, which is the half of
 * the pipeline that fails open.
 */
export async function recordOutflow(db: Database, observation: OutflowObservation): Promise<void> {
  if (!(observation.amountRaw > 0)) return;
  try {
    await db.insert(agentOutflowEvents).values(observation).onConflictDoNothing();
  } catch (error) {
    logger.warn(
      { error, agentAddress: observation.agentAddress, txSignature: observation.txSignature },
      'outflow-baseline: failed to record observation',
    );
  }
}

/**
 * What left the agent in one transaction, read from its balance changes.
 *
 * The sweep builds these from a `RawTxView`, but the sweep only walks agents
 * that already hold an active policy — so an agent nobody has insured yet has
 * no history, and the envelope derived at the quote falls back to its balance:
 * a cap nothing can cross, and agent-error cover that can never activate.
 * Cover that requires a history, and a history that requires cover.
 *
 * The risk assessment is the way out. It is required before a quote, it
 * already reads a hundred of the agent's transactions to score it, and those
 * carry the same balance changes. Underwriting an agent and writing down what
 * it spends are the same act.
 *
 * A balance *change*, not a transfer list: a transfer says who sent what, and
 * an outflow is what the account is left short by. The two differ whenever a
 * transaction both credits and debits the same account, and the second is what
 * the caps are measured against.
 */
export function outflowsFromBalanceChanges(input: {
  agentAddress: string;
  signature: string;
  blockTime: Date;
  accountData: Array<{
    tokenBalanceChanges: Array<{
      mint: string;
      userAccount: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
    }>;
  }>;
}): OutflowObservation[] {
  const byMint = new Map<string, { deltaRaw: number; decimals: number }>();

  for (const account of input.accountData) {
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount !== input.agentAddress) continue;
      const delta = Number(change.rawTokenAmount?.tokenAmount ?? 0);
      if (!Number.isFinite(delta)) continue;
      const seen = byMint.get(change.mint);
      byMint.set(change.mint, {
        deltaRaw: (seen?.deltaRaw ?? 0) + delta,
        decimals: change.rawTokenAmount?.decimals ?? seen?.decimals ?? 0,
      });
    }
  }

  const observations: OutflowObservation[] = [];
  for (const [mint, leg] of byMint) {
    if (leg.deltaRaw >= 0) continue;
    observations.push({
      agentAddress: input.agentAddress,
      txSignature: input.signature,
      mint,
      amountRaw: Math.abs(leg.deltaRaw),
      decimals: leg.decimals,
      blockTime: input.blockTime,
    });
  }
  return observations;
}

/**
 * Summarise an agent's outflow history as of a moment.
 *
 * `at` is passed in rather than read from a clock so the summary a verdict was
 * built on can be reproduced. `windowSeconds` is the mandate's own window —
 * the cumulative total has to be measured over the interval the holder
 * declared, not one this module picked.
 *
 * Returns `null` when there is no usable history. That is distinct from an
 * outage, which throws: the adjudicator treats the two differently, and
 * collapsing them would make a database hiccup look like a brand-new agent.
 */
export async function loadOutflowBaseline(
  db: Database,
  agentAddress: string,
  mint: string,
  at: Date,
  windowSeconds: number,
  /**
   * The transaction being judged, excluded from its own history.
   *
   * `recordOutflows` writes the trigger's row before the claim-keeper reads
   * this back, so without the exclusion the caller's own movement is already
   * inside the window sum — and the verifier then adds it a second time.
   * Doubling any transfer over half the declared cap manufactured a
   * `window_outflow` breach out of an entirely compliant payment.
   */
  excludeTxSignature?: string,
): Promise<OutflowBaselineView | null> {
  const historyFrom = new Date(at.getTime() - DEFAULT_OUTFLOW_WINDOW_SEC * 1000);
  const rows = await db
    .select({
      amountRaw: agentOutflowEvents.amountRaw,
      blockTime: agentOutflowEvents.blockTime,
    })
    .from(agentOutflowEvents)
    .where(
      and(
        eq(agentOutflowEvents.agentAddress, agentAddress),
        eq(agentOutflowEvents.mint, mint),
        gte(agentOutflowEvents.blockTime, historyFrom),
        lte(agentOutflowEvents.blockTime, at),
        ...(excludeTxSignature ? [ne(agentOutflowEvents.txSignature, excludeTxSignature)] : []),
      ),
    )
    .orderBy(asc(agentOutflowEvents.blockTime));

  if (rows.length === 0) return null;

  const amounts = rows.map((r) => r.amountRaw).sort((a, b) => a - b);
  const observedFrom = Math.floor(new Date(rows[0]!.blockTime).getTime() / 1000);
  const latest = Math.floor(new Date(rows[rows.length - 1]!.blockTime).getTime() / 1000);
  const atSec = Math.floor(at.getTime() / 1000);

  // The cumulative total inside the *mandate's* window, which is what the
  // window cap is compared against — a different interval from the one the
  // distribution is computed over.
  const windowFrom = new Date(at.getTime() - Math.max(0, windowSeconds) * 1000);
  const windowOutflowRaw = rows
    .filter((r) => new Date(r.blockTime) >= windowFrom)
    .reduce((sum, r) => sum + r.amountRaw, 0);

  return {
    windowSeconds,
    transferCount: rows.length,
    meanOutflowRaw: Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length),
    medianOutflowRaw: percentile(amounts, 0.5),
    p95OutflowRaw: percentile(amounts, 0.95),
    windowOutflowRaw,
    observedFrom,
    computedAt: atSec,
    // Too few observations is the same kind of problem as too old: the
    // distribution does not describe anything yet, and saying so is more
    // useful than reporting a p95 computed from two payments.
    stale: rows.length < MIN_OUTFLOW_OBSERVATIONS || atSec - latest > OUTFLOW_BASELINE_MAX_AGE_SEC,
  };
}

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}
