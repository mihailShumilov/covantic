/**
 * Sets the scene for a demo. No funded devnet pool exists to manipulate, so a
 * loss is staged: a swap between the covered agent and a counterparty at a
 * price the demo chooses. The evidence bundle records `stagedVenue: true`.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import type { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

const CAST_SOL = 0.02;
export const SUBJECT_LAMPORTS = 200_000_000n;

export interface Cast {
  agent: Keypair;
  counterparty: Keypair;
  holder: Keypair;
}

export function venueAccounts(cast: Cast, usdcMint: PublicKey): string[] {
  return [usdcMint, NATIVE_MINT].map((mint) =>
    getAssociatedTokenAddressSync(mint, cast.counterparty.publicKey).toBase58(),
  );
}

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner);
}

function openAccount(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint);
}

/** Creates three throwaway wallets and funds them from the demo funder. */
export async function fundCast(
  connection: Connection,
  funder: Keypair,
  usdcMint: PublicKey,
  amounts: { holderUsdcRaw: bigint; counterpartyUsdcRaw: bigint },
): Promise<Cast> {
  const cast: Cast = {
    agent: Keypair.generate(),
    counterparty: Keypair.generate(),
    holder: Keypair.generate(),
  };
  const payer = funder.publicKey;
  const fundingUsdc = ata(payer, usdcMint);

  const transaction = new Transaction();
  for (const wallet of [cast.agent, cast.counterparty, cast.holder]) {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: wallet.publicKey,
        lamports: CAST_SOL * LAMPORTS_PER_SOL,
      }),
    );
  }
  transaction.add(
    openAccount(payer, cast.agent.publicKey, usdcMint),
    openAccount(payer, cast.agent.publicKey, NATIVE_MINT),
    openAccount(payer, cast.counterparty.publicKey, usdcMint),
    openAccount(payer, cast.counterparty.publicKey, NATIVE_MINT),
    openAccount(payer, cast.holder.publicKey, usdcMint),
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: ata(cast.agent.publicKey, NATIVE_MINT),
      lamports: SUBJECT_LAMPORTS,
    }),
    createSyncNativeInstruction(ata(cast.agent.publicKey, NATIVE_MINT)),
    createTransferInstruction(
      fundingUsdc,
      ata(cast.holder.publicKey, usdcMint),
      payer,
      amounts.holderUsdcRaw,
    ),
    createTransferInstruction(
      fundingUsdc,
      ata(cast.counterparty.publicKey, usdcMint),
      payer,
      amounts.counterpartyUsdcRaw,
    ),
  );
  await sendAndConfirmTransaction(connection, transaction, [funder]);
  return cast;
}

/** The agent sells 0.2 wSOL to the counterparty for the given USDC amount. */
export async function stagedSwap(
  connection: Connection,
  cast: Cast,
  usdcMint: PublicKey,
  usdcRaw: bigint,
): Promise<string> {
  const agent = cast.agent.publicKey;
  const counterparty = cast.counterparty.publicKey;
  const transaction = new Transaction().add(
    createTransferInstruction(
      ata(agent, NATIVE_MINT),
      ata(counterparty, NATIVE_MINT),
      agent,
      SUBJECT_LAMPORTS,
    ),
    createTransferInstruction(ata(counterparty, usdcMint), ata(agent, usdcMint), counterparty, usdcRaw),
  );
  return sendAndConfirmTransaction(connection, transaction, [cast.agent, cast.counterparty]);
}

/** Current SOL/USD from the same consensus the verdict will use. */
export async function solPrice(oracle: {
  getPriceWindow: (feed: string, time: number) => Promise<{ anchor: { value: number } | null } | null>;
}): Promise<number> {
  const window = await oracle.getPriceWindow('SOL/USD', Math.floor(Date.now() / 1000) - 60);
  if (!window?.anchor) throw new Error('no SOL/USD reference available');
  return window.anchor.value;
}
