import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PDA_SEEDS, USDC_DECIMALS } from '@covantic/shared';
import { logger } from '../src/utils/logger.js';

// Load .env directly — this script intentionally bypasses the API's Zod
// env schema so it can run before optional vars (e.g. HELIUS_WEBHOOK_SECRET)
// are set up.
loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

const CONFIG_SEED = Buffer.from(PDA_SEEDS.CONFIG);
const VAULT_SEED = Buffer.from(PDA_SEEDS.VAULT);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function loadKeypair(path: string): Keypair {
  const absolute = path.startsWith('/') ? path : resolve(REPO_ROOT, path);
  const secret = JSON.parse(readFileSync(absolute, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function loadIdl(): Promise<Idl> {
  const jsonCandidates = [
    resolve(process.cwd(), 'packages/anchor/target/idl/covantic.json'),
    resolve(process.cwd(), '../anchor/target/idl/covantic.json'),
    resolve(process.cwd(), '../../packages/anchor/target/idl/covantic.json'),
  ];
  for (const path of jsonCandidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Idl;
    } catch {
      // try next
    }
  }
  // Fallback: the web package ships the hand-written IDL as a TS module.
  const webIdl = await import('../../web/src/idl/covantic.ts');
  return webIdl.COVANTIC_IDL as unknown as Idl;
}

function explorerTxUrl(sig: string, network: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${network}`;
}

const ENV_PATH = resolve(import.meta.dirname, '../../../.env');
const USDC_PLACEHOLDER = 'YOUR_DEVNET_USDC_MINT';

function updateEnvUsdcMint(mint: string): void {
  try {
    const content = readFileSync(ENV_PATH, 'utf-8');
    const next = content.match(/^USDC_MINT=.*/m)
      ? content.replace(/^USDC_MINT=.*/m, `USDC_MINT=${mint}`)
      : `${content.replace(/\s*$/, '')}\nUSDC_MINT=${mint}\n`;
    writeFileSync(ENV_PATH, next);
    logger.info(`Wrote USDC_MINT=${mint} to ${ENV_PATH}`);
  } catch (err) {
    logger.warn({ err }, 'Could not update .env automatically — set USDC_MINT manually');
  }
}

async function resolveUsdcMint(
  connection: Connection,
  payer: Keypair,
  configured: string | undefined,
): Promise<PublicKey> {
  if (configured && configured !== USDC_PLACEHOLDER && configured.length >= 32) {
    const mint = new PublicKey(configured);
    const info = await connection.getAccountInfo(mint);
    if (!info) {
      throw new Error(
        `USDC_MINT=${configured} is set but the account does not exist on this cluster.`,
      );
    }
    logger.info(`Using existing USDC mint: ${mint.toBase58()}`);
    return mint;
  }

  logger.info('USDC_MINT not configured; creating a new devnet mock-USDC mint...');
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    USDC_DECIMALS,
  );
  logger.info(`Created mock-USDC mint: ${mint.toBase58()}`);
  updateEnvUsdcMint(mint.toBase58());
  return mint;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run init against NODE_ENV=production.');
  }
  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const network = process.env.SOLANA_NETWORK ?? 'devnet';
  const programId = new PublicKey(requireEnv('PROGRAM_ID'));
  const keypair = loadKeypair(requireEnv('ORACLE_KEYPAIR_PATH'));
  const connection = new Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(keypair), {
    commitment: 'confirmed',
  });
  const program = new Program(await loadIdl(), provider);

  logger.info(`Initializing protocol on ${network}`);
  logger.info(`Admin/oracle: ${keypair.publicKey.toBase58()}`);
  logger.info(`Program ID:   ${programId.toBase58()}`);

  const configPda = PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
  const vaultPda = PublicKey.findProgramAddressSync([VAULT_SEED], programId)[0];
  logger.info(`Config PDA:   ${configPda.toBase58()}`);
  logger.info(`Vault PDA:    ${vaultPda.toBase58()}`);

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    logger.info('Protocol already initialized — nothing to do.');
    const cfgAcc: any = await (program.account as any).protocolConfig.fetch(configPda);
    logger.info(`  Oracle:    ${cfgAcc.oracleAuthority.toBase58()}`);
    logger.info(`  USDC mint: ${cfgAcc.usdcMint.toBase58()}`);
    process.exit(0);
  }

  const balance = await connection.getBalance(keypair.publicKey);
  logger.info(`Admin balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.05 * 1e9) {
    logger.warn('Admin balance is low; init may fail. Run `solana airdrop 2` first.');
  }

  const usdcMint = await resolveUsdcMint(connection, keypair, process.env.USDC_MINT);
  const vaultTokenAccount = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

  const sig = await program.methods
    .initialize(keypair.publicKey)
    .accounts({
      admin: keypair.publicKey,
      config: configPda,
      vault: vaultPda,
      usdcMint,
      vaultTokenAccount,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();

  logger.info(`Initialize tx: ${explorerTxUrl(sig, network)}`);
  logger.info('Protocol initialized successfully.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
