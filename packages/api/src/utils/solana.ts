import { Connection, PublicKey, Transaction, sendAndConfirmTransaction, Keypair } from '@solana/web3.js';
import { logger } from './logger.js';

/** Retry an RPC call with exponential backoff */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      const delay = baseDelay * 2 ** i;
      logger.warn({ error, attempt: i + 1, delay }, 'RPC call failed, retrying...');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/** Get SOL balance for an address */
export async function getSolBalance(connection: Connection, address: string): Promise<number> {
  const pubkey = new PublicKey(address);
  const balance = await withRetry(() => connection.getBalance(pubkey));
  return balance / 1e9; // Convert lamports to SOL
}

/** Send and confirm a transaction with retry */
export async function sendTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
): Promise<string> {
  return withRetry(() => sendAndConfirmTransaction(connection, transaction, signers));
}
