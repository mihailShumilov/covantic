/**
 * Stake USDC into the Covantic insurance vault.
 *
 * Uses a dedicated staker keypair (created on first run at
 * `keys/fleet-staker.json`), mints itself USDC via the oracle keypair (same
 * path fleet-bootstrap uses for holder funding) and calls `stake`.
 *
 * Usage:
 *   pnpm stake:vault                     # stake 1000 USDC (default)
 *   pnpm stake:vault --amount 5000       # stake 5000 USDC
 *   pnpm stake:vault --keypair <path>    # use a different staker keypair
 *
 * Why this exists: `create_policy` fails with SolvencyTooLow when
 * `total_staked / total_coverage < 50%`. Bumping stake with this script
 * unblocks `pnpm fleet:bootstrap` when the fleet outgrows the vault.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import anchorPkg, { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { PDA_SEEDS } from '@covantic/shared';

const { BN } = anchorPkg;

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const DEFAULT_STAKER_KEYPAIR = resolve(REPO_ROOT, 'keys/fleet-staker.json');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const abs = path.startsWith('/') ? path : resolve(REPO_ROOT, path);
  const secret = JSON.parse(readFileSync(abs, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function ensureKeypair(path: string): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  mkdirSync(dirname(path), { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  Generated new keypair at ${path} (pubkey ${kp.publicKey.toBase58()})`);
  return kp;
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok?.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

function loadIdl(): Idl {
  const path = resolve(REPO_ROOT, 'packages/anchor/target/idl/covantic.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as Idl;
}

async function ensureSol(
  connection: Connection,
  payer: Keypair,
  to: PublicKey,
  targetSol: number,
): Promise<void> {
  const needed = Math.round(targetSol * LAMPORTS_PER_SOL);
  const current = await connection.getBalance(to);
  if (current >= needed) return;
  const delta = needed - current;
  try {
    const sig = await connection.requestAirdrop(to, delta);
    await connection.confirmTransaction(sig, 'confirmed');
  } catch {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: to,
        lamports: delta,
      }),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
  }
}

async function ensureUsdc(
  connection: Connection,
  mintAuthority: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  targetUi: number,
): Promise<void> {
  const ata = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, mint, owner);
  const info = await connection.getTokenAccountBalance(ata.address);
  const currentUi = Number(info.value.uiAmount ?? 0);
  if (currentUi >= targetUi) return;
  const delta = targetUi - currentUi;
  const raw = BigInt(Math.round(delta * 10 ** 6));
  await mintTo(connection, mintAuthority, mint, ata.address, mintAuthority, raw);
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('stake-vault refuses to run with NODE_ENV=production');
  }

  const flags = parseFlags(process.argv.slice(2));
  const amountUi = Number(flags.amount ?? '1000');
  if (!Number.isFinite(amountUi) || amountUi <= 0) {
    throw new Error('--amount must be a positive number (UI USDC)');
  }
  const amountRaw = BigInt(Math.round(amountUi * 10 ** 6));
  const stakerPath = flags.keypair
    ? (flags.keypair.startsWith('/') ? flags.keypair : resolve(REPO_ROOT, flags.keypair))
    : DEFAULT_STAKER_KEYPAIR;

  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const usdcMint = new PublicKey(requireEnv('USDC_MINT'));
  const connection = new Connection(rpcUrl, 'confirmed');
  const mintAuthority = loadKeypair(requireEnv('ORACLE_KEYPAIR_PATH'));

  console.log('\n=== stake:vault ===');
  console.log(`  amount:     ${amountUi} USDC`);
  console.log(`  staker:     ${stakerPath}`);
  console.log(`  rpc:        ${rpcUrl}`);
  console.log(`  usdc mint:  ${usdcMint.toBase58()}`);

  const staker = ensureKeypair(stakerPath);
  console.log(`\nStaker pubkey: ${staker.publicKey.toBase58()}`);

  // Fund staker with enough SOL for fees + rent for the StakerPosition PDA
  // (StakerPosition::INIT_SPACE + 8, ~100 bytes → ~0.002 SOL rent). 0.05 SOL
  // is comfortable headroom.
  await ensureSol(connection, mintAuthority, staker.publicKey, 0.05);
  await ensureUsdc(connection, mintAuthority, usdcMint, staker.publicKey, amountUi);
  console.log(`  funded: 0.05 SOL + ${amountUi} USDC`);

  const wallet = new Wallet(staker);
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = loadIdl();
  const program = new Program(idl, provider);
  const programId = program.programId;

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.CONFIG)],
    programId,
  )[0];
  const vaultPda = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.VAULT)],
    programId,
  )[0];
  const stakerPositionPda = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.STAKER), staker.publicKey.toBuffer()],
    programId,
  )[0];

  const stakerAta = getAssociatedTokenAddressSync(usdcMint, staker.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pre = (await (program.account as any).insuranceVault.fetch(vaultPda)) as {
    totalStaked: anchorPkg.BN;
    totalCoverage: anchorPkg.BN;
    solvencyRatio: number;
  };
  console.log(
    `\nVault pre-stake: staked=${(Number(pre.totalStaked.toString()) / 1e6).toFixed(2)} USDC, ` +
      `coverage=${(Number(pre.totalCoverage.toString()) / 1e6).toFixed(2)} USDC, ` +
      `ratio=${(pre.solvencyRatio / 100).toFixed(2)}%`,
  );

  const signature = await program.methods
    .stake(new BN(amountRaw.toString()))
    .accounts({
      staker: staker.publicKey,
      config: configPda,
      vault: vaultPda,
      stakerPosition: stakerPositionPda,
      stakerTokenAccount: stakerAta,
      vaultTokenAccount: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([staker])
    .rpc({ commitment: 'confirmed' });

  await connection.confirmTransaction(signature, 'confirmed');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const post = (await (program.account as any).insuranceVault.fetch(vaultPda)) as {
    totalStaked: anchorPkg.BN;
    totalCoverage: anchorPkg.BN;
    solvencyRatio: number;
  };

  console.log(`\n✓ Stake tx: ${signature}`);
  console.log(
    `Vault post-stake: staked=${(Number(post.totalStaked.toString()) / 1e6).toFixed(2)} USDC, ` +
      `coverage=${(Number(post.totalCoverage.toString()) / 1e6).toFixed(2)} USDC, ` +
      `ratio=${(post.solvencyRatio / 100).toFixed(2)}%`,
  );
  console.log('\nNext: pnpm fleet:bootstrap\n');
}

main().catch((err) => {
  console.error('\n✗ stake:vault failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
