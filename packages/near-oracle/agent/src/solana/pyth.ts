import anchor from '@coral-xyz/anchor';
import type { AnchorProvider } from '@coral-xyz/anchor';
import type { Connection, Keypair, PublicKey } from '@solana/web3.js';

export interface PostedPrice {
  priceUpdate: PublicKey;
  signatures: string[];
}

/**
 * Posts a signed Pyth update with an ordinary funded key. Posting needs no
 * oracle authority, so the Pyth receiver stays out of the contract's allowlist
 * and the MPC key never signs anything but a Covantic instruction.
 *
 * The update account stays open until the payout has read it, because the two
 * land in separate transactions here.
 */
export async function postPriceUpdate(
  connection: Connection,
  relayer: Keypair,
  signedUpdateHex: string,
  feedIdHex: string,
): Promise<PostedPrice> {
  // Imported lazily: this package's dependency graph fails to load eagerly under ESM.
  const { PythSolanaReceiver } = await import('@pythnetwork/pyth-solana-receiver');
  const wallet = new anchor.Wallet(relayer);
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates([Buffer.from(signedUpdateHex, 'hex').toString('base64')]);

  let priceUpdate: PublicKey | undefined;
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    priceUpdate = getPriceUpdateAccount(`0x${feedIdHex}`);
    return [];
  });

  const provider = receiver.provider as AnchorProvider;
  const signatures = await provider.sendAll(
    await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 }),
    { skipPreflight: false },
  );
  if (!priceUpdate) throw new Error('Pyth update did not name the expected feed');
  return { priceUpdate, signatures };
}
