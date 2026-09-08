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
 * one already at the current size is a no-op that costs a signature.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { PDA_SEEDS } from '@covantic/shared';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

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
  const payer = loadKeypair(requireEnv('ORACLE_KEYPAIR_PATH'));
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

  const methods = program.methods as unknown as Record<
    string,
    () => { accounts: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } }
  >;

  let baselines = 0;
  let checkpoints = 0;
  for (const { publicKey: policy } of policies) {
    const [baseline] = PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.GOVERNANCE_BASELINE), policy.toBuffer()],
      program.programId,
    );
    const [checkpoint] = PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.AUTHORITY_CHECKPOINT), policy.toBuffer()],
      program.programId,
    );
    const [baselineInfo, checkpointInfo] = await connection.getMultipleAccountsInfo([
      baseline,
      checkpoint,
    ]);

    if (baselineInfo) {
      process.stdout.write(
        `policy ${policy.toBase58()}: baseline ${baselineInfo.data.length} bytes\n`,
      );
      if (!dryRun) {
        await methods.migrateGovernanceBaseline!()
          .accounts({
            payer: payer.publicKey,
            baseline,
            policy,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        baselines += 1;
      }
    }
    if (checkpointInfo) {
      process.stdout.write(
        `policy ${policy.toBase58()}: authority checkpoint ${checkpointInfo.data.length} bytes\n`,
      );
      if (!dryRun) {
        await methods.migrateAuthorityCheckpoint!()
          .accounts({
            payer: payer.publicKey,
            checkpoint,
            policy,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        checkpoints += 1;
      }
    }
  }

  process.stdout.write(
    dryRun
      ? 'dry run: nothing sent\n'
      : `migrated ${baselines} baselines and ${checkpoints} authority checkpoints\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
