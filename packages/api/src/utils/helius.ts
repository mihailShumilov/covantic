import { logger } from './logger.js';

/** Helius API client for Enhanced Transactions and other features */
export class HeliusClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.helius.xyz/v0';
  }

  /** Get enhanced transaction history for an address */
  async getEnhancedTransactions(
    address: string,
    options: { limit?: number; before?: string } = {},
  ) {
    const limit = options.limit ?? 100;
    const url = `${this.baseUrl}/addresses/${address}/transactions?api-key=${this.apiKey}&limit=${limit}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Helius API error: ${res.status}`);
      return await res.json();
    } catch (error) {
      logger.error({ error, address }, 'Failed to fetch enhanced transactions');
      return [];
    }
  }

  /** Get token balances for an address */
  async getTokenBalances(address: string) {
    const url = `${this.baseUrl}/addresses/${address}/balances?api-key=${this.apiKey}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Helius API error: ${res.status}`);
      return await res.json();
    } catch (error) {
      logger.error({ error, address }, 'Failed to fetch token balances');
      return { tokens: [], nativeBalance: 0 };
    }
  }

  /** Get account info */
  async getAccountInfo(address: string) {
    const url = `${this.baseUrl}/addresses/${address}/info?api-key=${this.apiKey}`;

    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.json();
    } catch (error) {
      logger.error({ error, address }, 'Failed to fetch account info');
      return null;
    }
  }

  /** Get parsed transaction details */
  async getParsedTransaction(signature: string) {
    const url = `${this.baseUrl}/transactions/?api-key=${this.apiKey}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [signature] }),
      });
      if (!res.ok) throw new Error(`Helius API error: ${res.status}`);
      const data = (await res.json()) as any[];
      return data[0] ?? null;
    } catch (error) {
      logger.error({ error, signature }, 'Failed to fetch parsed transaction');
      return null;
    }
  }
}
