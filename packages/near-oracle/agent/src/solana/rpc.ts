import type { EnhancedTransaction, SolanaReader } from '../predicate/baseline.js';

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 800;

/** A failed lookup is not an empty answer: callers must not read it as absence. */
export class RpcUnavailableError extends Error {}

/** Thin JSON-RPC reads. Values stay plain so they can enter an evidence bundle. */
export class SolanaRpc {
  constructor(private readonly url: string) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** attempt));
      }
      try {
        const response = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as RpcResponse<T>;
        if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
        return body.result as T;
      } catch (error) {
        lastError = error;
      }
    }
    throw new RpcUnavailableError(`${method} failed: ${String(lastError)}`);
  }

  getParsedTransaction(signature: string): Promise<ParsedTx | null> {
    return this.call('getTransaction', [
      signature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
  }

  getBlockAccounts(slot: number): Promise<unknown> {
    return this.call('getBlock', [
      slot,
      {
        encoding: 'json',
        transactionDetails: 'accounts',
        rewards: false,
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ]);
  }

  async recentSignatures(address: string, limit: number): Promise<string[]> {
    const entries = await this.call<Array<{ signature: string; err: unknown }>>(
      'getSignaturesForAddress',
      [address, { limit, commitment: 'confirmed' }],
    );
    return entries.filter((entry) => entry.err === null).map((entry) => entry.signature);
  }

  /** The two reads the baseline's signature collector makes. */
  asReader(): SolanaReader {
    return {
      getParsedTransaction: (signature: string) => this.getParsedTransaction(signature),
      getBlockAccounts: (slot: number) => this.getBlockAccounts(slot),
    } as unknown as SolanaReader;
  }
}

export interface ParsedKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

interface ParsedInstruction {
  programId: string;
  accounts?: string[];
  data?: string;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface ParsedTx {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: Array<{ index: number; instructions: ParsedInstruction[] }>;
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: ParsedKey[]; instructions: ParsedInstruction[] };
  };
}

function tokenChanges(tx: ParsedTx, accountIndex: number) {
  const meta = tx.meta;
  const pre = meta?.preTokenBalances?.find((entry) => entry.accountIndex === accountIndex);
  const post = meta?.postTokenBalances?.find((entry) => entry.accountIndex === accountIndex);
  const entry = post ?? pre;
  if (!entry?.owner) return [];
  const change = BigInt(post?.uiTokenAmount.amount ?? 0) - BigInt(pre?.uiTokenAmount.amount ?? 0);
  return [
    {
      mint: entry.mint,
      userAccount: entry.owner,
      rawTokenAmount: {
        tokenAmount: change.toString(),
        decimals: entry.uiTokenAmount.decimals,
      },
    },
  ];
}

/**
 * Builds the transaction shape the baseline reads, from the chain's own record.
 *
 * The baseline takes this shape from an indexer. The fields it reads are all
 * in `getTransaction`, so reading them here removes that vendor dependency.
 */
export function toEnhancedTransaction(tx: ParsedTx, signature: string): EnhancedTransaction {
  const { accountKeys, instructions } = tx.transaction.message;
  const inner = tx.meta?.innerInstructions ?? [];
  return {
    signature,
    timestamp: tx.blockTime ?? 0,
    slot: tx.slot,
    type: 'UNKNOWN',
    source: 'RPC',
    fee: tx.meta?.fee ?? 0,
    feePayer: accountKeys[0]?.pubkey ?? '',
    transactionError: tx.meta?.err ?? null,
    instructions: instructions.map((instruction, index) => ({
      programId: instruction.programId,
      accounts: instruction.accounts ?? [],
      data: instruction.data ?? '',
      innerInstructions: (inner.find((group) => group.index === index)?.instructions ?? []).map(
        (child) => ({
          programId: child.programId,
          accounts: child.accounts ?? [],
          data: child.data ?? '',
        }),
      ),
    })),
    tokenTransfers: [],
    accountData: accountKeys.map((key, index) => ({
      account: key.pubkey,
      nativeBalanceChange:
        (tx.meta?.postBalances[index] ?? 0) - (tx.meta?.preBalances[index] ?? 0),
      tokenBalanceChanges: tokenChanges(tx, index),
    })),
  } as unknown as EnhancedTransaction;
}
