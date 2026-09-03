import { PublicKey } from '@solana/web3.js';
import { logger } from './logger.js';
import {
  TOKEN_PROGRAM_ADDRESS,
  type ParsedTokenBalanceEntry,
  type ParsedTransactionView,
  type SolanaReader,
} from './solana-reader.js';

/** A `jsonParsed` instruction, in either of the two shapes the RPC emits. */
interface ParsedIxJson {
  programId?: unknown;
  accounts?: unknown[];
  data?: unknown;
  parsed?: unknown;
}

/** The message half of a parsed transaction, as the reader hands it over. */
type ParsedMessage = NonNullable<ParsedTransactionView['transaction']>['message'];
type ParsedMeta = ParsedTransactionView['meta'];

/** Validate a Base58 Solana address, returning it unchanged.
 *  Throws a descriptive Error if the address is structurally invalid,
 *  preventing malformed input from propagating into RPC calls. */
function parseAddress(address: string): string {
  // Quick structural check before handing off to the crypto parser
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error(`Invalid Solana address format: ${address}`);
  }
  new PublicKey(address);
  return address;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Classify RPC errors that should be retried. Rate limits (429) and transient
 *  5xx/network errors are retried; programmer errors (bad address, invalid
 *  method) are not. Keeping this centralized so analyzer + any future caller
 *  agree on what's transient. */
function isTransientRpcError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!msg) return false;
  if (/\b429\b|too many|rate.?limit/i.test(msg)) return true;
  if (/\b50[0-9]\b|bad gateway|gateway timeout|service unavailable/i.test(msg)) return true;
  if (/timeout|ECONNRESET|ENOTFOUND|ETIMEDOUT|network/i.test(msg)) return true;
  // solana-web3.js wraps RPC errors as `SolanaJSONRPCError` with a `code`
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && code >= -32099 && code <= -32000) return true;
  return false;
}

/** Retry a fallible RPC call with exponential backoff. Non-transient errors
 *  propagate immediately — only genuine rate-limit / transient failures are
 *  retried. This is what stops a throttled RPC from silently producing empty
 *  data that the risk scorer then turns into a fake "no activity" score. */
async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts - 1 || !isTransientRpcError(err)) break;
      // 400ms, 1.6s, 6.4s — keeps total wall time < 10s
      const backoffMs = 400 * 4 ** i;
      logger.warn({ label, attempt: i + 1, backoffMs, err }, 'RPC transient error — retrying');
      await delay(backoffMs);
    }
  }
  throw lastError;
}

/** Select evenly-distributed sample indices from a range, always including first and last */
function selectSample(total: number, maxSample: number): number[] {
  if (total <= maxSample) {
    return Array.from({ length: total }, (_, i) => i);
  }

  const indices = new Set<number>();
  indices.add(0); // Always include most recent
  indices.add(total - 1); // Always include oldest

  // Fill remaining with evenly-spaced indices
  const step = (total - 1) / (maxSample - 1);
  for (let i = 0; i < maxSample; i++) {
    indices.add(Math.round(i * step));
  }

  return [...indices].sort((a, b) => a - b);
}

/**
 * Normalized transaction data from Solana RPC (matches what risk-scorer expects).
 * Designed to be compatible with the EnhancedTransaction interface.
 */
export interface AnalyzedTransaction {
  signature: string;
  timestamp: number;
  type: string;
  fee: number;
  feePayer: string;
  transactionError: unknown | null;
  instructions: Array<{
    programId: string;
    accounts: string[];
    data: string;
    innerInstructions?: Array<{
      programId: string;
      accounts: string[];
      data: string;
    }>;
  }>;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }>;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
      userAccount: string;
    }>;
  }>;
}

export interface AnalyzedTokenBalance {
  mint: string;
  amount: number;
  decimals: number;
  tokenAccount: string;
}

export interface AnalyzedAccountInfo {
  createdAt?: string;
  lamports: number;
  owner: string;
  executable: boolean;
}

/** Known DEX program IDs for transaction type classification */
const DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
]);

/**
 * Analyzes a Solana wallet using standard RPC calls (no Helius dependency).
 * Works with any Solana cluster (devnet, mainnet-beta, localnet).
 */
export class SolanaRpcAnalyzer {
  private reader: SolanaReader;

  constructor(reader: SolanaReader) {
    this.reader = reader;
  }

  /** Fetch and analyze recent transactions for a wallet.
   *
   *  Strategy: Fetch all signatures (1 RPC call), then fetch parsed details
   *  for a sample of transactions to avoid devnet rate limits (2 req/s).
   *  Signatures alone provide: timestamp, error status, memo — enough for
   *  basic factors. Parsed txs add: programs, token transfers, balance changes.
   */
  async getAnalyzedTransactions(
    address: string,
    limit: number = 100,
  ): Promise<AnalyzedTransaction[]> {
    const pubkey = parseAddress(address);

    // Step 1: Get all recent signatures (single lightweight call). Retry on
    // transient failures; an empty array here means the wallet is legitimately
    // inactive and should NOT be conflated with an infrastructure error.
    const signatures = await withRpcRetry('getSignaturesForAddress', () =>
      this.reader.getSignaturesForAddress(pubkey, { limit }),
    );

    if (signatures.length === 0) return [];

    logger.info({ address, signatureCount: signatures.length }, 'Fetched signatures');

    // Step 2: Select a representative sample for full parsing
    const maxParsed = 30;
    const sampleIndices = selectSample(signatures.length, maxParsed);

    // Step 3: Fetch parsed transactions sequentially with per-call retries.
    // Per-transaction errors degrade to null so a single bad sig doesn't abort
    // the whole assessment; hard RPC failures still bubble via withRpcRetry.
    const parsedTxs = new Map<number, ParsedTransactionView | null>();

    for (let i = 0; i < sampleIndices.length; i++) {
      const idx = sampleIndices[i]!;
      const sig = signatures[idx]!;

      if (i > 0) await delay(200);

      try {
        const tx = await withRpcRetry('getParsedTransaction', () =>
          this.reader.getParsedTransaction(sig.signature),
        );
        parsedTxs.set(idx, tx);
      } catch (err) {
        logger.warn({ address, signature: sig.signature, err }, 'parsed tx fetch failed — continuing');
        parsedTxs.set(idx, null);
      }
    }

    // Step 4: Build analyzed transactions — full data for sampled, minimal for others
    const analyzed: AnalyzedTransaction[] = [];

    for (let i = 0; i < signatures.length; i++) {
      const sigInfo = signatures[i]!;
      const parsedTx = parsedTxs.get(i) ?? null;

      analyzed.push(this.normalizeTransaction(address, sigInfo.signature, sigInfo, parsedTx));
    }

    logger.info(
      { address, total: signatures.length, parsed: parsedTxs.size },
      'Transaction analysis complete',
    );

    return analyzed;
  }

  /** Get token balances for a wallet */
  async getTokenBalances(address: string): Promise<{
    tokens: AnalyzedTokenBalance[];
    nativeBalance: number;
  }> {
    const pubkey = parseAddress(address);

    const [balance, tokenAccounts] = await Promise.all([
      withRpcRetry('getBalance', () => this.reader.getBalance(pubkey)),
      withRpcRetry('getParsedTokenAccountsByOwner', () =>
        this.reader.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ADDRESS }),
      ),
    ]);

    const tokens: AnalyzedTokenBalance[] = tokenAccounts.accounts.map((account) => ({
      mint: account.mint,
      amount: Number(account.amount),
      decimals: account.decimals ?? 0,
      tokenAccount: account.pubkey,
    }));

    return { tokens, nativeBalance: balance };
  }

  /** Get account info for a wallet */
  async getAccountInfo(address: string): Promise<AnalyzedAccountInfo | null> {
    const pubkey = parseAddress(address);
    const info = await withRpcRetry('getAccountInfo', () => this.reader.getAccountInfo(pubkey));

    if (!info) return null;

    // Estimate creation time from oldest available transaction. This call is
    // non-critical — we already have account info; age is auxiliary — so a
    // retryable failure here doesn't fail the whole lookup.
    let createdAt: string | undefined;
    try {
      const sigs = await withRpcRetry('getSignaturesForAddress(age)', () =>
        this.reader.getSignaturesForAddress(pubkey, { limit: 100 }),
      );
      if (sigs.length > 0) {
        const oldest = sigs[sigs.length - 1];
        if (oldest?.blockTime) {
          createdAt = new Date(oldest.blockTime * 1000).toISOString();
        }
      }
    } catch (err) {
      logger.warn({ address, err }, 'wallet age lookup failed — falling back to tx history');
    }

    return {
      createdAt,
      lamports: info.lamports,
      owner: info.owner,
      executable: info.executable,
    };
  }

  /** Normalize a parsed Solana transaction into our analysis format */
  private normalizeTransaction(
    walletAddress: string,
    signature: string,
    sigInfo: { blockTime?: number | null | undefined; err: unknown },
    tx: ParsedTransactionView | null,
  ): AnalyzedTransaction {
    const timestamp = sigInfo.blockTime ?? 0;
    const hasError = sigInfo.err != null;

    if (!tx?.transaction) {
      return {
        signature,
        timestamp,
        type: 'UNKNOWN',
        fee: 5000,
        feePayer: walletAddress,
        transactionError: hasError ? sigInfo.err : null,
        instructions: [],
        tokenTransfers: [],
        nativeTransfers: [],
        accountData: [],
      };
    }

    const message = tx.transaction.message;
    const meta = tx.meta;

    // Extract instructions
    const instructions = message.instructions.map((raw, ixIndex) => {
      const ix = raw as ParsedIxJson;
      const innerIxs = meta?.innerInstructions?.find((inner) => inner.index === ixIndex);

      return {
        programId: String(ix.programId ?? ''),
        accounts: this.getInstructionAccounts(ix),
        data: this.getInstructionData(ix),
        innerInstructions: (innerIxs?.instructions as ParsedIxJson[] | undefined)?.map((inner) => ({
          programId: String(inner.programId ?? ''),
          accounts: this.getInstructionAccounts(inner),
          data: this.getInstructionData(inner),
        })),
      };
    });

    // Classify transaction type
    const type = this.classifyTransactionType(instructions, meta, walletAddress);

    // Extract native SOL transfers from balance changes
    const nativeTransfers = this.extractNativeTransfers(message, meta);

    // Extract token transfers from token balance changes
    const tokenTransfers = this.extractTokenTransfers(meta, walletAddress);

    // Build account data with balance changes
    const accountData = this.extractAccountData(message, meta);

    return {
      signature,
      timestamp,
      type,
      fee: meta?.fee ?? 5000,
      feePayer: message.accountKeys[0]?.pubkey ?? walletAddress,
      transactionError: meta?.err ?? null,
      instructions,
      tokenTransfers,
      nativeTransfers,
      accountData,
    };
  }

  private getInstructionAccounts(ix: ParsedIxJson): string[] {
    return Array.isArray(ix.accounts) ? ix.accounts.map((a) => String(a)) : [];
  }

  private getInstructionData(ix: ParsedIxJson): string {
    if (typeof ix.data === 'string') return ix.data;
    if (ix.parsed !== undefined) return JSON.stringify(ix.parsed);
    return '';
  }

  /** Classify transaction type based on program interactions */
  private classifyTransactionType(
    instructions: AnalyzedTransaction['instructions'],
    meta: ParsedMeta,
    _walletAddress: string,
  ): string {
    const programIds = new Set(instructions.map((ix) => ix.programId));

    // Check inner instructions too
    for (const ix of instructions) {
      for (const inner of ix.innerInstructions ?? []) {
        programIds.add(inner.programId);
      }
    }

    // DEX interaction → SWAP
    for (const pid of programIds) {
      if (DEX_PROGRAMS.has(pid)) return 'SWAP';
    }

    // Token transfers
    const hasTokenChanges = (meta?.preTokenBalances?.length ?? 0) > 0 ||
      (meta?.postTokenBalances?.length ?? 0) > 0;

    if (hasTokenChanges) return 'TRANSFER';

    // System transfer
    if (programIds.has('11111111111111111111111111111111') && programIds.size <= 2) {
      return 'TRANSFER';
    }

    // Compute budget only
    if (programIds.size === 1 && programIds.has('ComputeBudget111111111111111111111111111111')) {
      return 'UNKNOWN';
    }

    return 'UNKNOWN';
  }

  /** Extract native SOL transfers by pairing senders with receivers.
   *  Groups accounts by positive/negative balance change, then pairs the
   *  largest sender with the largest receiver greedily. This avoids the
   *  incorrect assumption that all transfers involve the fee payer. */
  private extractNativeTransfers(
    message: ParsedMessage,
    meta: ParsedMeta,
  ): AnalyzedTransaction['nativeTransfers'] {
    if (!meta) return [];

    const accounts = message.accountKeys;
    const senders: { address: string; amount: number }[] = [];
    const receivers: { address: string; amount: number }[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const pre = meta.preBalances[i] ?? 0;
      const post = meta.postBalances[i] ?? 0;
      const diff = post - pre;
      if (diff === 0) continue;

      // Skip fee payer (index 0) fee deduction — only record if there is
      // a significant balance change beyond the tx fee
      const address = accounts[i]!.pubkey;
      if (diff > 0) {
        receivers.push({ address, amount: diff });
      } else {
        // For fee payer, ignore small decreases likely from tx fees (< 0.01 SOL)
        if (i === 0 && Math.abs(diff) < 10_000_000) continue;
        senders.push({ address, amount: Math.abs(diff) });
      }
    }

    // Greedily pair largest sender → largest receiver
    const transfers: AnalyzedTransaction['nativeTransfers'] = [];
    senders.sort((a, b) => b.amount - a.amount);
    receivers.sort((a, b) => b.amount - a.amount);

    for (const sender of senders) {
      for (const receiver of receivers) {
        if (receiver.amount <= 0) continue;
        const amount = Math.min(sender.amount, receiver.amount);
        if (amount <= 0) continue;
        transfers.push({
          fromUserAccount: sender.address,
          toUserAccount: receiver.address,
          amount,
        });
        sender.amount -= amount;
        receiver.amount -= amount;
        if (sender.amount <= 0) break;
      }
    }

    return transfers;
  }

  /** Extract token transfers from pre/post token balance changes */
  private extractTokenTransfers(
    meta: ParsedMeta,
    walletAddress: string,
  ): AnalyzedTransaction['tokenTransfers'] {
    if (!meta) return [];

    const preMap = new Map<string, ParsedTokenBalanceEntry>();
    for (const bal of meta.preTokenBalances ?? []) {
      const key = `${bal.owner ?? ''}-${bal.mint}`;
      preMap.set(key, bal);
    }

    const transfers: AnalyzedTransaction['tokenTransfers'] = [];

    for (const post of meta.postTokenBalances ?? []) {
      const key = `${post.owner ?? ''}-${post.mint}`;
      const pre = preMap.get(key);

      const preAmount = pre ? Number(pre.uiTokenAmount?.amount ?? 0) : 0;
      const postAmount = Number(post.uiTokenAmount?.amount ?? 0);
      const diff = postAmount - preAmount;

      if (diff !== 0 && post.owner) {
        transfers.push({
          fromUserAccount: diff < 0 ? post.owner : walletAddress,
          toUserAccount: diff > 0 ? post.owner : walletAddress,
          fromTokenAccount: '',
          toTokenAccount: '',
          tokenAmount: Math.abs(diff) / 10 ** (post.uiTokenAmount?.decimals ?? 0),
          mint: post.mint,
          tokenStandard: 'fungible',
        });
      }
    }

    return transfers;
  }

  /** Extract account-level balance changes */
  private extractAccountData(
    message: ParsedMessage,
    meta: ParsedMeta,
  ): AnalyzedTransaction['accountData'] {
    if (!meta) return [];

    // Token balances, paired by account index.
    //
    // This used to return an empty array for every account, so the whole shape
    // described SOL and nothing else. `agent_outflow_events` is built from
    // these changes, and the envelope a quote derives is drawn from that
    // history — so an agent could move USDC all day and be underwritten as one
    // that had never spent anything, which put its cap at its own balance: a
    // limit nothing can cross.
    //
    // A *change*, not a transfer: what the account is left short by is what
    // the declared caps are measured against, and a transaction that both
    // credits and debits the same account moves less than its transfers say.
    const tokenChangesByIndex = new Map<
      number,
      Array<{ mint: string; userAccount: string; rawTokenAmount: { tokenAmount: string; decimals: number } }>
    >();

    const preByIndex = new Map<number, { amount: number; decimals: number }>();
    for (const pre of meta.preTokenBalances ?? []) {
      preByIndex.set(pre.accountIndex, {
        amount: Number(pre.uiTokenAmount?.amount ?? 0),
        decimals: pre.uiTokenAmount?.decimals ?? 0,
      });
    }

    const seen = new Set<number>();
    for (const post of meta.postTokenBalances ?? []) {
      seen.add(post.accountIndex);
      const pre = preByIndex.get(post.accountIndex);
      const decimals = post.uiTokenAmount?.decimals ?? pre?.decimals ?? 0;
      const delta = Number(post.uiTokenAmount?.amount ?? 0) - (pre?.amount ?? 0);
      if (delta === 0 || !post.owner) continue;
      const list = tokenChangesByIndex.get(post.accountIndex) ?? [];
      list.push({
        mint: post.mint,
        userAccount: post.owner,
        rawTokenAmount: { tokenAmount: String(delta), decimals },
      });
      tokenChangesByIndex.set(post.accountIndex, list);
    }

    // An account emptied and closed in the same transaction has a pre balance
    // and no post balance. Dropping it would hide the largest movement there
    // is — the one that took everything.
    for (const pre of meta.preTokenBalances ?? []) {
      if (seen.has(pre.accountIndex)) continue;
      const amount = Number(pre.uiTokenAmount?.amount ?? 0);
      if (amount === 0 || !pre.owner) continue;
      const list = tokenChangesByIndex.get(pre.accountIndex) ?? [];
      list.push({
        mint: pre.mint,
        userAccount: pre.owner,
        rawTokenAmount: {
          tokenAmount: String(-amount),
          decimals: pre.uiTokenAmount?.decimals ?? 0,
        },
      });
      tokenChangesByIndex.set(pre.accountIndex, list);
    }

    return message.accountKeys.map((key, i) => ({
      account: key.pubkey,
      nativeBalanceChange: (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0),
      tokenBalanceChanges: tokenChangesByIndex.get(i) ?? [],
    }));
  }
}
