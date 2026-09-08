/**
 * Grow every governance baseline and authority checkpoint written under the
 * previous layout to the current one.
 *
 * Usage:
 *   pnpm gov:migrate            # every policy the program knows
 *   pnpm gov:migrate --dry-run  # report only
 *
 * Both accounts grew: the baseline now retains the whole declaration it
 * replaced, and the checkpoint retains the predecessor's close authority.
 * `declare_governance_baseline` and `checkpoint_authority` both use
 * `init_if_needed`, which deserialises an existing account before any
 * constraint could resize it, so an unmigrated account fails to load until it
 * is grown. The crank self-heals a checkpoint it finds undersized; this
 * script does both in one pass, ahead of time, so no claim has to discover
 * the gap.
 *
 * Permissionless and idempotent: the program only ever grows an account, and
 * one already at the current size is skipped here without a transaction.
 *
 * Reads are batched a hundred accounts at a time and writes are paced, because
 * the public devnet endpoint rate-limits a burst of per-policy calls and the
 * script has to walk every policy the program has ever issued.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { PDA_SEEDS } from '@covantic/shared';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** Current sizes, as `GovernanceBaseline::LEN` and
 *  `PolicyAuthorityCheckpoint::LEN` compute them. An account at or above the
 *  size needs no transaction. */
const BASELINE_LEN =
  8 +
  8 +
  32 +
  32 +
  33 +
  33 +
  33 +
  33 +
  2 +
  32 * 4 +
  1 +
  32 +
  8 +
  8 +
  32 +
  8 +
  1 +
  33 +
  33 +
  32 * 4 +
  1 +
  32 +
  8;
const CHECKPOINT_LEN =
  8 + 8 + 32 + 32 + 33 + 8 + 33 + 1 + 8 + 8 + 8 + 32 + 33 + 1 + 8 + 8 + 8 + 1 + 33;

const READ_BATCH = 100;
const WRITE_PAUSE_MS = 1_500;
const SEND_ATTEMPTS = 3;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function loadKeypair(path: string): Keypair {
  const abs = path.startsWith('/') ? path : resolve(REPO_ROOT, path);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(abs, 'utf-8')) as number[]));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const payer = loadKeypair(
    process.env.MIGRATION_PAYER_KEYPAIR_PATH ?? requireEnv('ORACLE_KEYPAIR_PATH'),
  );
  const connection = new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' });
  const idl = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'packages/anchor/target/idl/covantic.json'), 'utf-8'),
  ) as Idl;
  const program = new Program(idl, provider);

  const accounts = program.account as unknown as Record<
    string,
    { all: () => Promise<Array<{ publicKey: PublicKey }>> }
  >;
  const policies = await accounts.insurancePolicy!.all();
  process.stdout.write(`${policies.length} policies\n`);

  const targets = policies.map(({ publicKey: policy }) => ({
    policy,
    baseline: PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.GOVERNANCE_BASELINE), policy.toBuffer()],
      program.programId,
    )[0],
    checkpoint: PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.AUTHORITY_CHECKPOINT), policy.toBuffer()],
      program.programId,
    )[0],
  }));

  // One read per hundred accounts, not two per policy.
  const addresses = targets.flatMap((t) => [t.baseline, t.checkpoint]);
  const sizes = new Map<string, number>();
  for (let at = 0; at < addresses.length; at += READ_BATCH) {
    const chunk = addresses.slice(at, at + READ_BATCH);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    infos.forEach((info, i) => {
      if (info) sizes.set(chunk[i]!.toBase58(), info.data.length);
    });
    await sleep(WRITE_PAUSE_MS);
  }

  const methods = program.methods as unknown as Record<
    string,
    () => { accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } }
  >;

  /** A rate-limited endpoint answers 429 and drops the confirmation socket;
   *  neither says the transaction failed. Retry with backoff, and move on to
   *  the next account rather than abandoning the run — the script is
   *  idempotent and a rerun picks up whatever is still short. */
  const send = async (label: string, rpc: () => Promise<string>): Promise<boolean> => {
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      try {
        await rpc();
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${label}: attempt ${attempt} failed: ${message.slice(0, 160)}\n`);
        await sleep(WRITE_PAUSE_MS * 2 ** attempt);
      }
    }
    return false;
  };

  let baselinesGrown = 0;
  let checkpointsGrown = 0;
  let alreadyCurrent = 0;
  let failed = 0;
  for (const { policy, baseline, checkpoint } of targets) {
    const baselineSize = sizes.get(baseline.toBase58());
    const checkpointSize = sizes.get(checkpoint.toBase58());

    if (baselineSize !== undefined) {
      if (baselineSize >= BASELINE_LEN) {
        alreadyCurrent += 1;
      } else {
        process.stdout.write(
          `policy ${policy.toBase58()}: baseline ${baselineSize} -> ${BASELINE_LEN} bytes\n`,
        );
        if (!dryRun) {
          const ok = await send(`baseline ${baseline.toBase58()}`, () =>
            methods.migrateGovernanceBaseline!()
              .accounts({
                payer: payer.publicKey,
                baseline,
                policy,
                systemProgram: SystemProgram.programId,
              })
              .rpc(),
          );
          if (ok) baselinesGrown += 1;
          else failed += 1;
          await sleep(WRITE_PAUSE_MS);
        }
      }
    }
    if (checkpointSize !== undefined) {
      if (checkpointSize >= CHECKPOINT_LEN) {
        alreadyCurrent += 1;
      } else {
        process.stdout.write(
          `policy ${policy.toBase58()}: authority checkpoint ${checkpointSize} -> ${CHECKPOINT_LEN} bytes\n`,
        );
        if (!dryRun) {
          const ok = await send(`checkpoint ${checkpoint.toBase58()}`, () =>
            methods.migrateAuthorityCheckpoint!()
              .accounts({
                payer: payer.publicKey,
                checkpoint,
                policy,
                systemProgram: SystemProgram.programId,
              })
              .rpc(),
          );
          if (ok) checkpointsGrown += 1;
          else failed += 1;
          await sleep(WRITE_PAUSE_MS);
        }
      }
    }
  }

  const pending = [...sizes.entries()].filter(([address, size]) => {
    const isBaseline = targets.some((t) => t.baseline.toBase58() === address);
    return size < (isBaseline ? BASELINE_LEN : CHECKPOINT_LEN);
  }).length;

  process.stdout.write(
    dryRun
      ? `dry run: ${pending} accounts need growing, ${alreadyCurrent} already current; nothing sent\n`
      : `migrated ${baselinesGrown} baselines and ${checkpointsGrown} authority checkpoints; ${alreadyCurrent} already current; ${failed} failed\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
