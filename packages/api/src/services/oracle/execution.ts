import { canonicalMint, lookupMint, NATIVE_SOL_PSEUDO_MINT } from '@covantic/shared';
import type { EnhancedTransaction } from '../../utils/helius.js';

/**
 * What the transaction actually did to the agent's balance sheet.
 *
 * `swap`               one mint out, one mint in
 * `aggregated_swap`    several mints on one side (split route, dust legs)
 * `no_swap`            value moved one way only, so there is no price to imply
 * `no_position_change` nothing net changed (self-transfer, wrap/unwrap only)
 * `unsupported_shape`  several mints on both sides; no single implied price
 */
export type SwapShape =
  | 'swap'
  | 'aggregated_swap'
  | 'no_swap'
  | 'no_position_change'
  | 'unsupported_shape';

export interface NetDelta {
  /** Canonical mint; wrapped SOL is folded onto native SOL. */
  mint: string;
  /** Absolute size in UI units. Direction lives in `sold` vs `bought`. */
  amountUi: number;
  decimals: number;
}

export interface ExecutionSummary {
  shape: SwapShape;
  /** What left the agent, positive amounts. */
  sold: NetDelta[];
  /** What arrived, positive amounts. */
  bought: NetDelta[];
  /** Transaction fee in lamports, added back before computing the SOL delta
   *  so a network fee never reads as part of the trade. */
  feeLamports: number;
  /** Native SOL residue that was dropped as rent/dust, lamports. */
  droppedSolDustLamports: number;
  note?: string;
}

/** Native SOL movement below this is account rent and dust, not a trade leg.
 *  Only dropped when the transaction has other legs to reason about. */
const SOL_DUST_LAMPORTS = 10_000_000; // 0.01 SOL

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Reconstruct the agent's net position change from authoritative balance
 * deltas.
 *
 * The previous approach — take the largest outgoing transfer and the largest
 * incoming one — reads a multi-hop Jupiter route as a swap between two
 * unrelated intermediate legs, double-counts split routes, and treats a wSOL
 * wrap as a trade. `accountData[].tokenBalanceChanges` is the pre/post diff
 * the chain itself recorded, so netting it per mint gives the position change
 * regardless of how many hops produced it.
 *
 * Two deliberate normalisations:
 *   - wrapped SOL is folded onto native SOL, so wrap/unwrap inside a route
 *     nets to zero instead of appearing as a leg;
 *   - the transaction fee is added back, so paying for the block is not
 *     scored as an execution shortfall.
 */
export function reconstructExecution(
  tx: EnhancedTransaction,
  agentAddress: string,
): ExecutionSummary {
  const rawByMint = new Map<string, { raw: number; decimals: number }>();

  for (const account of tx.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      if (change.userAccount !== agentAddress) continue;
      const raw = Number(change.rawTokenAmount?.tokenAmount);
      if (!Number.isFinite(raw) || raw === 0) continue;
      const mint = canonicalMint(change.mint);
      const decimals = change.rawTokenAmount?.decimals ?? lookupMint(mint)?.decimals ?? 0;
      const entry = rawByMint.get(mint) ?? { raw: 0, decimals };
      entry.raw += raw;
      // Trust the largest decimals seen; they must agree for a given mint,
      // and disagreement means one record is malformed.
      entry.decimals = Math.max(entry.decimals, decimals);
      rawByMint.set(mint, entry);
    }
  }

  // Native SOL, fee excluded.
  const feeLamports = Number(tx.fee ?? 0);
  const agentAccount = (tx.accountData ?? []).find((a) => a.account === agentAddress);
  let nativeLamports = Number(agentAccount?.nativeBalanceChange ?? 0);
  if (tx.feePayer === agentAddress && Number.isFinite(feeLamports)) {
    nativeLamports += feeLamports;
  }
  if (Number.isFinite(nativeLamports) && nativeLamports !== 0) {
    const entry = rawByMint.get(NATIVE_SOL_PSEUDO_MINT) ?? { raw: 0, decimals: 9 };
    entry.raw += nativeLamports;
    entry.decimals = 9;
    rawByMint.set(NATIVE_SOL_PSEUDO_MINT, entry);
  }

  // Drop SOL rent/dust once there is something else to look at — but never
  // when it is the only thing on its side of the trade. Removing a swap's
  // sole counter-leg turns it into a one-way transfer and the verifier stops
  // looking at it, which is the wrong answer for a small but real swap.
  let droppedSolDustLamports = 0;
  const sol = rawByMint.get(NATIVE_SOL_PSEUDO_MINT);
  if (sol && rawByMint.size > 1 && Math.abs(sol.raw) < SOL_DUST_LAMPORTS) {
    const solIsPositive = sol.raw > 0;
    const hasCompanionOnSameSide = [...rawByMint].some(
      ([mint, entry]) => mint !== NATIVE_SOL_PSEUDO_MINT && entry.raw > 0 === solIsPositive,
    );
    if (hasCompanionOnSameSide) {
      droppedSolDustLamports = sol.raw;
      rawByMint.delete(NATIVE_SOL_PSEUDO_MINT);
    }
  }

  const sold: NetDelta[] = [];
  const bought: NetDelta[] = [];
  for (const [mint, { raw, decimals }] of rawByMint) {
    if (raw === 0) continue;
    const amountUi = Math.abs(raw) / 10 ** decimals;
    if (amountUi === 0) continue;
    (raw < 0 ? sold : bought).push({ mint, amountUi, decimals });
  }

  const byMint = (a: NetDelta, b: NetDelta) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
  sold.sort(byMint);
  bought.sort(byMint);

  return {
    shape: classify(sold, bought),
    sold,
    bought,
    feeLamports,
    droppedSolDustLamports,
    note: noteFor(sold, bought),
  };
}

function classify(sold: NetDelta[], bought: NetDelta[]): SwapShape {
  if (sold.length === 0 && bought.length === 0) return 'no_position_change';
  if (sold.length === 0 || bought.length === 0) return 'no_swap';
  if (sold.length === 1 && bought.length === 1) return 'swap';
  if (sold.length === 1 || bought.length === 1) return 'aggregated_swap';
  return 'unsupported_shape';
}

function noteFor(sold: NetDelta[], bought: NetDelta[]): string | undefined {
  switch (classify(sold, bought)) {
    case 'no_position_change':
      return 'Net balances unchanged — self-transfer, or wrap/unwrap only.';
    case 'no_swap':
      return 'Value moved in one direction only; no exchange rate is implied.';
    case 'unsupported_shape':
      return 'Multiple mints on both sides — no single implied price. Needs review.';
    default:
      return undefined;
  }
}

/** Sum of raw lamports in a delta list, for logging and assertions. */
export function totalUi(deltas: NetDelta[]): number {
  return deltas.reduce((sum, d) => sum + d.amountUi, 0);
}

export { SOL_DUST_LAMPORTS, LAMPORTS_PER_SOL };
