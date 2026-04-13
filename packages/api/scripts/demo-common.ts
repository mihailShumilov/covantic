import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PDA_SEEDS, policyIdToBytes } from '@covantic/shared';
import { loadConfig } from '../src/config/env.js';

/**
 * Demo scripts operate on-chain with real keypairs. Refuse to run against
 * production environments -- this is a one-line guard, not a security boundary.
 * Callers must still ensure the correct `DATABASE_URL` / `ORACLE_KEYPAIR_PATH`
 * point at devnet infrastructure.
 */
export function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Demo scripts must not run with NODE_ENV=production. Aborting.',
    );
  }
}

export const CONFIG_SEED = Buffer.from(PDA_SEEDS.CONFIG);
export const VAULT_SEED = Buffer.from(PDA_SEEDS.VAULT);
export const POLICY_SEED = Buffer.from(PDA_SEEDS.POLICY);
export const STAKER_SEED = Buffer.from(PDA_SEEDS.STAKER);

export function loadKeypair(path: string): Keypair {
  const absolute = path.startsWith('/') ? path : resolve(process.cwd(), path);
  const secret = JSON.parse(readFileSync(absolute, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function loadIdl(): Idl {
  const candidates = [
    resolve(process.cwd(), 'packages/anchor/target/idl/covantic.json'),
    resolve(process.cwd(), '../anchor/target/idl/covantic.json'),
    resolve(process.cwd(), '../../packages/anchor/target/idl/covantic.json'),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Idl;
    } catch {
      // try next
    }
  }
  throw new Error(
    'Covantic IDL not found. Run `anchor build` in packages/anchor first.',
  );
}

export function setupProgram() {
  assertNotProduction();
  const cfg = loadConfig();
  const connection = new Connection(cfg.SOLANA_RPC_URL, 'confirmed');
  const keypair = loadKeypair(cfg.ORACLE_KEYPAIR_PATH);
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = loadIdl();
  const programId = new PublicKey(cfg.PROGRAM_ID);
  const program = new Program(idl, provider);
  return { cfg, connection, keypair, wallet, provider, program, programId };
}

/**
 * Load a policy holder keypair for demo flows that must sign as the policy
 * holder (e.g. submit_claim). Falls back to the oracle keypair so the
 * existing seed-demo flow keeps working, but emits a warning — on a real
 * devnet demo you want `DEMO_HOLDER_KEYPAIR_PATH` set to a separate key.
 */
export function loadDemoHolderKeypair(oracle: Keypair): Keypair {
  const path = process.env.DEMO_HOLDER_KEYPAIR_PATH;
  if (path && path.trim().length > 0) {
    return loadKeypair(path);
  }
  console.warn(
    'DEMO_HOLDER_KEYPAIR_PATH not set; falling back to oracle keypair for holder actions',
  );
  return oracle;
}

export function derivePda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function policyIdBuffer(id: bigint): Buffer {
  return Buffer.from(policyIdToBytes(id));
}

export function explorerTxUrl(sig: string, network = 'devnet'): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${network}`;
}
