/**
 * Day-1 spike: prove that a NEAR testnet account can control a Solana devnet
 * address through Chain Signatures, and measure whether signing fits inside
 * blockhash validity.
 *
 * Steps: read the derived Ed25519 key from the MPC contract, fund the address,
 * then for each run build a memo transaction, send its raw message to the MPC
 * `sign` method, attach the signature, verify it locally and land it.
 */
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { Account, JsonRpcProvider, KeyPairSigner, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';

const MPC_CONTRACT_ID = 'v1.signer-prod.testnet';
const ED25519_DOMAIN_ID = 1;
const DERIVATION_PATH = 'covantic-spike-v1';
const NEAR_RPC_URL = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MIN_BALANCE_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
const RUNS = Number(process.env.SPIKE_RUNS ?? 3);
/** Sign and verify only. Needs no SOL, so it works before the address is funded. */
const DRY_RUN = process.env.SPIKE_DRY_RUN === '1';
/** Pads the memo so a run can match the size of a real payout message. */
const MEMO_PADDING_BYTES = Number(process.env.SPIKE_MEMO_PADDING ?? 0);

interface Ed25519SignResponse {
  scheme: string;
  signature: number[];
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set, run spike/create-account.ts first`);
  return value;
}

async function deriveAddress(provider: JsonRpcProvider, accountId: string): Promise<PublicKey> {
  const derived = await provider.callFunction<string>({
    contractId: MPC_CONTRACT_ID,
    method: 'derived_public_key',
    args: { path: DERIVATION_PATH, predecessor: accountId, domain_id: ED25519_DOMAIN_ID },
  });
  if (!derived?.startsWith('ed25519:')) {
    throw new Error(`unexpected derived key: ${String(derived)}`);
  }
  return new PublicKey(derived.slice('ed25519:'.length));
}

async function ensureFunded(connection: Connection, address: PublicKey): Promise<void> {
  const balance = await connection.getBalance(address);
  log(`balance ${balance / LAMPORTS_PER_SOL} SOL`);
  if (balance >= MIN_BALANCE_LAMPORTS) return;
  const signature = await connection.requestAirdrop(address, LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, 'confirmed');
  log(`airdrop https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}

async function signWithMpc(account: Account, message: Buffer): Promise<Buffer> {
  const response = await account.callFunction<Ed25519SignResponse>({
    contractId: MPC_CONTRACT_ID,
    methodName: 'sign',
    args: {
      request: {
        payload_v2: { Eddsa: message.toString('hex') },
        path: DERIVATION_PATH,
        domain_id: ED25519_DOMAIN_ID,
      },
    },
    gas: teraToGas(100),
    deposit: 1n,
  });
  if (response?.scheme !== 'Ed25519' || response.signature.length !== 64) {
    throw new Error(`unexpected MPC response: ${JSON.stringify(response)}`);
  }
  return Buffer.from(response.signature);
}

async function runOnce(
  run: number,
  account: Account,
  connection: Connection,
  address: PublicKey,
): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const heightBefore = await connection.getBlockHeight('confirmed');

  const transaction = new Transaction({
    feePayer: address,
    recentBlockhash: blockhash,
  }).add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: address, isSigner: true, isWritable: false }],
      data: Buffer.from(
        `covantic near-oracle spike run ${run} ${new Date().toISOString()} ` +
          'x'.repeat(MEMO_PADDING_BYTES),
      ),
    }),
  );
  const message = transaction.serializeMessage();

  const signingStarted = performance.now();
  const signature = await signWithMpc(account, message);
  const signingMs = performance.now() - signingStarted;
  const heightAfter = await connection.getBlockHeight('confirmed');

  transaction.addSignature(address, signature);
  if (!transaction.verifySignatures()) {
    throw new Error('MPC signature does not verify against the derived address');
  }

  if (DRY_RUN) {
    log(
      `run ${run}: message ${message.length} bytes, sign ${(signingMs / 1000).toFixed(1)}s, ` +
        `blocks consumed ${heightAfter - heightBefore} of ${lastValidBlockHeight - heightBefore}, ` +
        'signature verifies against derived address (dry run, not sent)',
    );
    return;
  }

  const sendStarted = performance.now();
  const txSignature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(
    { signature: txSignature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  const landingMs = performance.now() - sendStarted;

  log(
    [
      `run ${run}:`,
      `message ${message.length} bytes,`,
      `sign ${(signingMs / 1000).toFixed(1)}s,`,
      `landing ${(landingMs / 1000).toFixed(1)}s,`,
      `blocks consumed ${heightAfter - heightBefore} of ${lastValidBlockHeight - heightBefore}`,
    ].join(' '),
  );
  log(`  https://explorer.solana.com/tx/${txSignature}?cluster=devnet`);
}

async function main(): Promise<void> {
  const accountId = requireEnv('NEAR_ACCOUNT_ID');
  const privateKey = requireEnv('NEAR_PRIVATE_KEY') as KeyPairString;

  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const signer = KeyPairSigner.fromSecretKey(privateKey);
  const account = new Account(accountId, provider, signer);
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  log(`near account ${accountId}`);
  const address = await deriveAddress(provider, accountId);
  log(`derived solana address ${address.toBase58()} (path ${DERIVATION_PATH})`);
  log(`https://explorer.solana.com/address/${address.toBase58()}?cluster=devnet`);

  if (!DRY_RUN) await ensureFunded(connection, address);
  for (let run = 1; run <= RUNS; run += 1) {
    await runOnce(run, account, connection, address);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`spike failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
