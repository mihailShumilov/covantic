import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import type { Connection, TransactionInstruction } from '@solana/web3.js';

/** Must stay within `MAX_COMPUTE_UNIT_LIMIT` in the contract's guardrails. */
const COMPUTE_UNIT_LIMIT = 400_000;

export interface UnsignedTransaction {
  transaction: Transaction;
  message: Buffer;
  lastValidBlockHeight: number;
}

/**
 * Builds a legacy transaction paid by the oracle. Only the legacy format is
 * used because the contract reads the message it signs and refuses every
 * versioned one.
 */
export async function buildOracleTransaction(
  connection: Connection,
  oracle: PublicKey,
  instruction: TransactionInstruction,
): Promise<UnsignedTransaction> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: oracle, recentBlockhash: blockhash })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }))
    .add(instruction);
  return { transaction, message: transaction.serializeMessage(), lastValidBlockHeight };
}

/** Attaches the MPC signature, checks it, and lands the transaction. */
export async function broadcast(
  connection: Connection,
  unsigned: UnsignedTransaction,
  oracle: PublicKey,
  signature: Buffer,
): Promise<string> {
  unsigned.transaction.addSignature(oracle, signature);
  if (!unsigned.transaction.verifySignatures()) {
    throw new Error('the MPC signature does not verify against the oracle address');
  }
  const txSignature = await connection.sendRawTransaction(unsigned.transaction.serialize(), {
    preflightCommitment: 'confirmed',
  });
  const { value } = await connection.confirmTransaction(
    {
      signature: txSignature,
      blockhash: unsigned.transaction.recentBlockhash as string,
      lastValidBlockHeight: unsigned.lastValidBlockHeight,
    },
    'confirmed',
  );
  if (value.err) throw new Error(`transaction ${txSignature} failed: ${JSON.stringify(value.err)}`);
  return txSignature;
}
