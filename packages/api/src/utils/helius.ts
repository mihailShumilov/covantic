import { logger } from './logger.js';

/** Base58 Solana address validation — same alphabet as routes/risk.ts */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Solana transaction signature: 87–88 Base58 characters */
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

function assertAddress(address: string): void {
  if (!SOLANA_ADDRESS_RE.test(address)) {
    throw new Error(`Invalid Solana address: ${address}`);
  }
}

function assertSignature(signature: string): void {
  if (!SOLANA_SIGNATURE_RE.test(signature)) {
    throw new Error(`Invalid Solana signature: ${signature}`);
  }
}

/** Known DEX router program IDs on Solana */
const KNOWN_DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v2
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // Serum
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CPMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', // Phoenix
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora Pools
]);

/** Known bridge program IDs */
const KNOWN_BRIDGE_PROGRAMS = new Set([
  'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb', // Wormhole
  'Bridge1p5gheXUvJ6jGWGeCsgPKgnE3YgdGKRVCMY9ip', // Wormhole Token Bridge
  'DEbrdGj3HsRsAzx6uH4MKyREKxVAfBydijLUF3ygsFfh', // deBridge
  // Allbridge: actual program ID not yet confirmed — placeholder removed to avoid
  // false-negative matches against arbitrary strings in the lookup set.
]);

/** Known risky/unverified categories of programs */
const KNOWN_RISKY_PATTERNS = [
  'memo', // Often used in scam txs
];

/** Flash loan / leverage programs */
const FLASH_LOAN_PROGRAMS = new Set([
  'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo', // Solend
  'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', // Marginfi
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Drift
  'KLend2g3cP87ber8pJ3wQWZaFFi6TGDKP1UvqWu3n', // Kamino
]);

/** Helius Enhanced Transaction type */
export interface EnhancedTransaction {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
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
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
      userAccount: string;
    }>;
  }>;
}

/** Token balance info from Helius */
export interface TokenBalance {
  mint: string;
  amount: number;
  decimals: number;
  tokenAccount: string;
}

/** Account info from Helius */
export interface AccountInfo {
  createdAt?: string;
  lamports: number;
  owner: string;
  executable: boolean;
}

/** Helius API client for Enhanced Transactions and deep wallet analysis. */
export class HeliusClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.helius.xyz/v0';
  }

  /** Get enhanced transaction history for an address.
   *  Throws on HTTP failure so callers can surface a real error instead of
   *  treating an outage as "empty wallet". 404 is the one exception — Helius
   *  returns 404 for never-seen addresses, which IS a legitimate empty result. */
  async getEnhancedTransactions(
    address: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<EnhancedTransaction[]> {
    assertAddress(address);
    const limit = Math.min(Math.max(1, options.limit ?? 100), 100);
    const params = new URLSearchParams({ 'api-key': this.apiKey, limit: String(limit) });
    const url = `${this.baseUrl}/addresses/${encodeURIComponent(address)}/transactions?${params}`;

    const res = await fetch(url);
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`Helius getEnhancedTransactions failed: HTTP ${res.status}`);
    }
    return (await res.json()) as EnhancedTransaction[];
  }

  /** Get token balances for an address. Throws on HTTP failure. */
  async getTokenBalances(address: string): Promise<{ tokens: TokenBalance[]; nativeBalance: number }> {
    assertAddress(address);
    const params = new URLSearchParams({ 'api-key': this.apiKey });
    const url = `${this.baseUrl}/addresses/${encodeURIComponent(address)}/balances?${params}`;

    const res = await fetch(url);
    if (res.status === 404) return { tokens: [], nativeBalance: 0 };
    if (!res.ok) {
      throw new Error(`Helius getTokenBalances failed: HTTP ${res.status}`);
    }
    return (await res.json()) as { tokens: TokenBalance[]; nativeBalance: number };
  }

  /** Get account info. 404 means "account does not exist" — a legitimate
   *  null, not an error. Other failures throw. */
  async getAccountInfo(address: string): Promise<AccountInfo | null> {
    assertAddress(address);
    const params = new URLSearchParams({ 'api-key': this.apiKey });
    const url = `${this.baseUrl}/addresses/${encodeURIComponent(address)}/info?${params}`;

    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Helius getAccountInfo failed: HTTP ${res.status}`);
    }
    return (await res.json()) as AccountInfo;
  }

  /** Get parsed transaction details */
  async getParsedTransaction(signature: string): Promise<EnhancedTransaction | null> {
    assertSignature(signature);
    const params = new URLSearchParams({ 'api-key': this.apiKey });
    const url = `${this.baseUrl}/transactions/?${params}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // signature is validated above — safe to include in the JSON body
        body: JSON.stringify({ transactions: [signature] }),
      });
      if (!res.ok) throw new Error(`Helius API error: ${res.status}`);
      const data = (await res.json()) as EnhancedTransaction[];
      return data[0] ?? null;
    } catch (error) {
      logger.error({ error, signature }, 'Failed to fetch parsed transaction');
      return null;
    }
  }
}

export { KNOWN_DEX_PROGRAMS, KNOWN_BRIDGE_PROGRAMS, KNOWN_RISKY_PATTERNS, FLASH_LOAN_PROGRAMS };
