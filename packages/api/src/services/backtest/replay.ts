import type { Connection } from '@solana/web3.js';
import type { HeliusClient, EnhancedTransaction } from '../../utils/helius.js';
import { buildConsensusWindow } from '../oracle/consensus.js';
import type { PriceOracle, PricePoint, PriceSourceId, PriceWindow } from '../oracle/types.js';
import type { Cassette, CassetteTx } from './types.js';

/**
 * Replay adapters.
 *
 * Everything here converts a frozen RPC response into the three inputs
 * `verifyClaim` takes, and does nothing else. In particular none of it makes a
 * decision: no defaulting a missing price to par, no inventing an owner, no
 * treating an unparsed instruction as harmless. A cassette that cannot supply
 * something must let the pipeline see it as absent, because "absent" is a case
 * the adjudicators are supposed to handle and a fabricated value would hide
 * exactly the bug worth finding.
 */

// ---------------------------------------------------------------------------
// Chain record
// ---------------------------------------------------------------------------

/**
 * A connection that serves one frozen transaction.
 *
 * The corroboration lookups return empty rather than throwing, which reports
 * those signatures as *evaluated and absent*. Making them unavailable instead
 * would let a case pass by being unknowable, and the point of a backtest is
 * the opposite.
 */
export function cassetteConnection(cassette: Cassette): Connection {
  const tx = cassette.tx;
  return {
    getParsedTransaction: async (signature: string) =>
      signature === cassette.signature ? tx : null,
    getTransaction: async (signature: string) =>
      signature === cassette.signature ? { slot: tx.slot, blockTime: tx.blockTime } : null,
    getSignaturesForAddress: async () => [],
    getAccountInfo: async () => null,
    // A cassette holds one transaction, not the block around it. Returning
    // null makes the same-block sandwich check report *unevaluated*, which is
    // true; synthesising a block containing only this transaction would say
    // "checked, nothing adjacent" about a block we never saw.
    getBlock: async () => null,
  } as unknown as Connection;
}

export function cassetteHelius(cassette: Cassette): HeliusClient {
  const enhanced = toEnhanced(cassette);
  return {
    getParsedTransaction: async (signature: string) =>
      signature === cassette.signature ? enhanced : null,
  } as unknown as HeliusClient;
}

// ---------------------------------------------------------------------------
// Indexer envelope
// ---------------------------------------------------------------------------

interface ParsedIxJson {
  programId?: string;
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
  accounts?: string[];
  data?: string;
}

interface TokenBalanceJson {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

const SPL_TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Rebuild the indexer's enhanced shape from the chain's own record.
 *
 * The pipeline prefers the raw view and falls back to this one, so the
 * fallback has to be reconstructed honestly rather than left empty — an empty
 * envelope would make every cassette exercise the same code path and hide
 * whatever the fallback gets wrong.
 *
 * Two details are worth stating because they are easy to get subtly wrong:
 * `tokenBalanceChanges[].userAccount` is the *owner wallet*, not the token
 * account, and `accountData[].account` is the account whose balance moved —
 * a token account for token legs, a wallet for native ones. Swapping those is
 * silent: the numbers still add up, they just belong to the wrong party.
 */
export function toEnhanced(cassette: Cassette): EnhancedTransaction {
  const tx = cassette.tx;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const meta = tx.meta;

  const outer = (tx.transaction.message.instructions ?? []) as ParsedIxJson[];
  const inner = (meta.innerInstructions ?? []).flatMap(
    (group) => (group.instructions ?? []) as ParsedIxJson[],
  );

  // Owner and mint of every token account this transaction touched, taken
  // from the balance tables — a bare `transfer` instruction names neither.
  const tokenAccountMint = new Map<string, { mint: string; decimals: number }>();
  const tokenAccountOwner = new Map<string, string>();
  for (const side of [meta.preTokenBalances ?? [], meta.postTokenBalances ?? []]) {
    for (const raw of side as TokenBalanceJson[]) {
      const account = keys[raw.accountIndex];
      if (!account) continue;
      tokenAccountMint.set(account, {
        mint: raw.mint,
        decimals: raw.uiTokenAmount?.decimals ?? 0,
      });
      if (raw.owner) tokenAccountOwner.set(account, raw.owner);
    }
  }

  const tokenTransfers: EnhancedTransaction['tokenTransfers'] = [];
  const nativeTransfers: EnhancedTransaction['nativeTransfers'] = [];

  for (const ix of [...outer, ...inner]) {
    const programId = ix.programId ?? '';
    const type = ix.parsed?.type;
    const info = ix.parsed?.info ?? {};

    if (SPL_TOKEN_PROGRAMS.has(programId) && (type === 'transfer' || type === 'transferChecked')) {
      const source = String(info.source ?? '');
      const destination = String(info.destination ?? '');
      const known = tokenAccountMint.get(source) ?? tokenAccountMint.get(destination);
      const mint = typeof info.mint === 'string' ? info.mint : known?.mint;
      const decimals =
        (info.tokenAmount as { decimals?: number } | undefined)?.decimals ?? known?.decimals;
      const rawAmount =
        typeof info.amount === 'string'
          ? Number(info.amount)
          : Number((info.tokenAmount as { amount?: string } | undefined)?.amount ?? NaN);
      // No mint or no decimals means the amount cannot be scaled. Dropping the
      // leg is right: a transfer recorded at the wrong scale is worse than one
      // the indexer never reported.
      if (!mint || decimals === undefined || !Number.isFinite(rawAmount)) continue;
      tokenTransfers.push({
        fromUserAccount: tokenAccountOwner.get(source) ?? '',
        toUserAccount: tokenAccountOwner.get(destination) ?? '',
        fromTokenAccount: source,
        toTokenAccount: destination,
        tokenAmount: rawAmount / 10 ** decimals,
        mint,
        tokenStandard: 'Fungible',
      });
      continue;
    }

    if (programId === SYSTEM_PROGRAM && type === 'transfer') {
      const lamports = Number(info.lamports ?? NaN);
      if (!Number.isFinite(lamports)) continue;
      nativeTransfers.push({
        fromUserAccount: String(info.source ?? ''),
        toUserAccount: String(info.destination ?? ''),
        amount: lamports,
      });
    }
  }

  // Signed token deltas per account, from the balance tables rather than from
  // the instruction stream: a seizure moves no tokens and would be invisible
  // in the transfers alone.
  const preToken = new Map<string, number>();
  for (const raw of (meta.preTokenBalances ?? []) as TokenBalanceJson[]) {
    const account = keys[raw.accountIndex];
    if (account) preToken.set(account, Number(raw.uiTokenAmount?.amount ?? '0'));
  }

  const accountData: EnhancedTransaction['accountData'] = keys.map((account, i) => ({
    account,
    nativeBalanceChange: Number(meta.postBalances?.[i] ?? 0) - Number(meta.preBalances?.[i] ?? 0),
    tokenBalanceChanges: [],
  }));

  for (const raw of (meta.postTokenBalances ?? []) as TokenBalanceJson[]) {
    const account = keys[raw.accountIndex];
    const entry = accountData[raw.accountIndex];
    if (!account || !entry) continue;
    const post = Number(raw.uiTokenAmount?.amount ?? '0');
    const delta = post - (preToken.get(account) ?? 0);
    if (!Number.isFinite(delta) || delta === 0) continue;
    entry.tokenBalanceChanges.push({
      mint: raw.mint,
      rawTokenAmount: { tokenAmount: String(delta), decimals: raw.uiTokenAmount?.decimals ?? 0 },
      userAccount: raw.owner ?? '',
    });
  }

  return {
    signature: cassette.signature,
    timestamp: tx.blockTime ?? 0,
    slot: tx.slot,
    type: 'UNKNOWN',
    source: 'BACKTEST',
    fee: Number(meta.fee ?? 0),
    feePayer: keys[0] ?? '',
    transactionError: meta.err ?? null,
    instructions: outer.map((ix) => ({
      programId: ix.programId ?? '',
      accounts: ix.accounts ?? [],
      data: ix.data ?? '',
    })),
    tokenTransfers,
    nativeTransfers,
    accountData,
  };
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * The reference prices that were true when the transaction executed.
 *
 * Built through the same {@link buildConsensusWindow} production uses, so a
 * backtest cannot pass by being priced more generously than a live claim. A
 * feed with no stored observations returns null — the pipeline's own
 * "cannot price" path — rather than falling back to par.
 */
export function cassettePricer(cassette: Cassette): PriceOracle {
  return {
    async getPriceWindow(feedKey: string, targetTime: number): Promise<PriceWindow | null> {
      const stored = cassette.prices[feedKey];
      if (!stored || stored.length === 0) return null;
      const contributors: PricePoint[] = stored.map((p) => ({
        value: p.value,
        conf: p.conf,
        publishTime: p.publishTime,
        slot: null,
        source: p.source as PriceSourceId,
        feedId: p.feedId,
        raw: null,
      }));
      return buildConsensusWindow(feedKey, targetTime, contributors, []);
    },
  };
}

/** Every account key in the transaction, for picking a subject wallet. */
export function accountKeysOf(tx: CassetteTx): string[] {
  return tx.transaction.message.accountKeys.map((k) => k.pubkey);
}
