import type { Connection } from '@solana/web3.js';
import type { EnhancedTransaction } from '../../utils/helius.js';
import { logger } from '../../utils/logger.js';

/** Sanity floor for a Solana block time. Anything earlier than 2020-01-01 is
 *  a parsing accident (milliseconds mistaken for seconds, a zero default),
 *  not a real transaction. */
const MIN_PLAUSIBLE_BLOCK_TIME = 1_577_836_800;

/** Helius and the RPC agreeing within this many seconds is normal rounding.
 *  Beyond it, one of them is wrong about which block we are looking at, and
 *  a price anchored to the wrong block proves nothing. */
const BLOCK_TIME_AGREEMENT_SEC = 2;

export interface TxTime {
  slot: number | null;
  blockTime: number | null;
  /** Absolute gap between the Helius and RPC block times, when both were
   *  available. Carried into the evidence bundle so a disagreement is
   *  visible in the audit trail instead of being resolved silently. */
  disagreementSec?: number;
}

/**
 * Establish *when* the trigger transaction executed.
 *
 * Everything downstream hangs off this: the price window, the slot-indexed
 * pool state, the reversion test. Getting it from a single indexer would
 * make the whole evidence chain depend on that indexer being right, so when
 * an RPC connection is available the Helius value is cross-checked against
 * `getTransaction().blockTime` and any disagreement is recorded.
 *
 * Returns `blockTime: null` when no plausible time can be established. The
 * caller must treat that as indeterminate — never substitute the current
 * time, which is precisely the bug that made the original verifier compare a
 * historical swap against a live spot price.
 */
export async function resolveTxTime(
  tx: EnhancedTransaction,
  connection?: Connection | null,
): Promise<TxTime> {
  const heliusTime = plausible(tx.timestamp) ? tx.timestamp : null;
  const heliusSlot = typeof tx.slot === 'number' && tx.slot > 0 ? tx.slot : null;

  if (!connection) {
    return { slot: heliusSlot, blockTime: heliusTime };
  }

  let rpcTime: number | null = null;
  let rpcSlot: number | null = null;
  try {
    const parsed = await connection.getTransaction(tx.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (parsed) {
      rpcTime = plausible(parsed.blockTime ?? null) ? (parsed.blockTime as number) : null;
      rpcSlot = parsed.slot ?? null;
    }
  } catch (err) {
    // An RPC hiccup must not degrade the Helius answer we already hold.
    logger.debug(
      { err: err instanceof Error ? err.message : err, signature: tx.signature },
      'resolveTxTime: RPC cross-check unavailable, using indexer values',
    );
  }

  if (heliusTime !== null && rpcTime !== null) {
    const disagreementSec = Math.abs(heliusTime - rpcTime);
    if (disagreementSec > BLOCK_TIME_AGREEMENT_SEC) {
      logger.warn(
        { signature: tx.signature, heliusTime, rpcTime, disagreementSec },
        'resolveTxTime: indexer and RPC disagree on block time',
      );
    }
    // Prefer the RPC: it is the chain's own answer, the indexer is a copy.
    return {
      slot: rpcSlot ?? heliusSlot,
      blockTime: rpcTime,
      disagreementSec,
    };
  }

  return {
    slot: rpcSlot ?? heliusSlot,
    blockTime: rpcTime ?? heliusTime,
  };
}

function plausible(t: number | null | undefined): boolean {
  return typeof t === 'number' && Number.isFinite(t) && t >= MIN_PLAUSIBLE_BLOCK_TIME;
}
