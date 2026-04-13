import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { USDC_DECIMALS } from '@covantic/shared';
import { logger } from '../src/utils/logger.js';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const absolute = path.startsWith('/') ? path : resolve(REPO_ROOT, path);
  const secret = JSON.parse(readFileSync(absolute, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const recipientArg = process.argv[2];
  const amountArg = process.argv[3] ?? '1000';
  if (!recipientArg) {
    console.error('Usage: tsx mint-mock-usdc.ts <recipient-pubkey> [amount=1000]');
    process.exit(1);
  }
  const recipient = new PublicKey(recipientArg);
  const amountUi = Number(amountArg);
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    throw new Error(`Invalid amount: ${amountArg}`);
  }

  const connection = new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
  const authority = loadKeypair(requireEnv('ORACLE_KEYPAIR_PATH'));
  const mint = new PublicKey(requireEnv('USDC_MINT'));

  logger.info(`Mint:       ${mint.toBase58()}`);
  logger.info(`Authority:  ${authority.publicKey.toBase58()}`);
  logger.info(`Recipient:  ${recipient.toBase58()}`);
  logger.info(`Amount:     ${amountUi} USDC`);

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    recipient,
  );
  logger.info(`Recipient ATA: ${ata.address.toBase58()}`);

  const amountRaw = BigInt(Math.round(amountUi * 10 ** USDC_DECIMALS));
  const sig = await mintTo(
    connection,
    authority,
    mint,
    ata.address,
    authority,
    amountRaw,
  );
  logger.info(`Mint tx: ${sig}`);
  logger.info('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
