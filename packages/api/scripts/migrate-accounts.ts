/**
 * Grow the accounts a program upgrade left behind.
 *
 * Usage:
 *   pnpm --filter api exec tsx scripts/migrate-accounts.ts --keypair ~/.config/solana/id.json
 *   pnpm --filter api exec tsx scripts/migrate-accounts.ts --dry-run
 *
 * Run this immediately after deploying a program build that grew
 * `InsuranceVault` or `StakerPosition`, and before anything else touches the
 * protocol. Until it has run, **every instruction that takes the vault fails**
 * — including `create_policy`, which is how the gap announces itself:
 *
 *     AnchorError caused by account: vault.
 *     Error Code: AccountDidNotDeserialize. Error Number: 3003.
 *
 * That error is not a bug in the caller. `Account<T>` deserializes during
 * `try_accounts`, and an account written before `loss_index` existed is 16
 * bytes short, so it fails before any handler runs. The program ships
 * `migrate_vault` and `migrate_staker_position` for exactly this; both take
 * `UncheckedAccount`, verify the discriminator by hand, and grow the account
 * to the current layout.
 *
 * Both are permissionless and idempotent — they return early when the account
 * is already large enough — so re-running this is safe. The signer pays the
 * rent top-up, nothing more.
 *
 * "Idempotent" is load-bearing and was, briefly, not quite true: the vault
 * migration seeded `loss_index` whenever it read zero, and a vault whose
 * stakers had been wiped out to the last unit also read zero — so a re-run
 * restored full scale and erased a socialised loss. The program now floors the
 * index at 1 and only seeds an account it actually grew. This script still
 * skips a vault that is already the right size, so an unnecessary transaction
 * is not sent at all.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { PDA_SEEDS } from '@covantic/shared';
import { rpcEndpointName } from '../src/config/rpc-pool.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const IDL_PATH = resolve(REPO_ROOT, 'packages/anchor/target/idl/covantic.json');

/** Anchor's 8-byte account discriminator for `StakerPosition`, from the IDL. */
const STAKER_POSITION_DISCRIMINATOR = [202, 156, 49, 48, 230, 210, 246, 197];

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadKeypair(path: string): Keypair {
  const abs = path.startsWith('~') ? resolve(homedir(), path.slice(2)) : resolve(REPO_ROOT, path);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(abs, 'utf-8')) as number[]));
}

/**
 * `8 + InsuranceVault::INIT_SPACE` — the size the vault migration grows to.
 * Read from the account after a successful migration rather than recomputed
 * from the IDL, because the IDL on disk can be older than the deployment.
 */
const VAULT_MIGRATED_SIZE = 136;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const keypairPath =
    flag('keypair') ?? process.env.ORACLE_KEYPAIR_PATH ?? '~/.config/solana/id.json';
  const payer = loadKeypair(keypairPath);

  const idl = JSON.parse(readFileSync(IDL_PATH, 'utf-8')) as Idl;
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' });
  const program = new Program(idl, provider);
  const programId = program.programId;

  console.log(`rpc     ${rpcEndpointName(rpcUrl)}`);
  console.log(`program ${programId.toBase58()}`);
  console.log(`payer   ${payer.publicKey.toBase58()}`);
  if (dryRun) console.log('DRY RUN — nothing will be sent\n');

  // --- vault ---------------------------------------------------------------
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.VAULT)], programId);
  const vaultInfo = await connection.getAccountInfo(vault);
  if (!vaultInfo) {
    throw new Error(`vault ${vault.toBase58()} does not exist — is the protocol initialised?`);
  }
  console.log(`\nvault ${vault.toBase58()} — ${vaultInfo.data.length} bytes`);
  // The program returns early on an already-sized account, so this only saves
  // a transaction — but it also makes the log say what actually happened
  // rather than reporting a migration that did nothing.
  const vaultAlreadySized = vaultInfo.data.length >= VAULT_MIGRATED_SIZE;
  if (vaultAlreadySized) console.log('  already migrated — skipping');

  if (!dryRun && !vaultAlreadySized) {
    const signature = await program.methods
      .migrateVault()
      .accounts({ payer: payer.publicKey, vault, systemProgram: SystemProgram.programId })
      .rpc();
    const after = await connection.getAccountInfo(vault);
    console.log(`  migrated -> ${after?.data.length} bytes  (${signature})`);
  }

  // --- staker positions ----------------------------------------------------
  // Every position, not only the short ones: the instruction decides for
  // itself, and a size check here would be a second opinion about the layout
  // that could drift from the program's.
  // Offset 9, not 8: `StakerPosition` opens with a `version: u8` and only then
  // the staker pubkey. Slicing at 8 yields an address that looks plausible and
  // derives to the wrong PDA, which the program rejects with ConstraintSeeds.
  const positions = await connection.getProgramAccounts(programId, {
    dataSlice: { offset: 9, length: 32 },
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: Buffer.from(STAKER_POSITION_DISCRIMINATOR).toString('base64'),
          encoding: 'base64',
        },
      },
    ],
  });
  console.log(`\nstaker positions: ${positions.length}`);

  for (const { pubkey, account } of positions) {
    const staker = new PublicKey(account.data);
    process.stdout.write(`  ${pubkey.toBase58()} (staker ${staker.toBase58()}) `);
    if (dryRun) {
      console.log('— skipped');
      continue;
    }
    try {
      const signature = await program.methods
        .migrateStakerPosition()
        .accounts({
          payer: payer.publicKey,
          stakerPosition: pubkey,
          staker,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`— migrated (${signature.slice(0, 16)}…)`);
    } catch (err) {
      // One position failing must not strand the rest; report and continue.
      console.log(`— FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\ndone');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
