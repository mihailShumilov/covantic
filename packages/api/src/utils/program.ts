import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from '@solana/web3.js';
import { loadKeypair } from '../config/solana.js';
import type { AppConfig } from '../config/env.js';

/**
 * Look for the Anchor IDL in a few candidate locations so the API works
 * whether it's run from the monorepo root, packages/api, or a built dist.
 */
function loadIdl(): Idl {
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

/**
 * Minimal Wallet stub for read-only program queries. Throws on any signing
 * attempt so a read path cannot accidentally issue a transaction.
 */
class ReadOnlyWallet implements Wallet {
  public readonly publicKey: PublicKey;
  private readonly kp: Keypair;
  constructor() {
    this.kp = Keypair.generate();
    this.publicKey = this.kp.publicKey;
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> {
    throw new Error('ReadOnlyWallet cannot sign transactions');
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> {
    throw new Error('ReadOnlyWallet cannot sign transactions');
  }
  get payer(): Keypair {
    return this.kp;
  }
}

export interface CovanticProgram {
  program: Program<Idl>;
  provider: AnchorProvider;
  connection: Connection;
  programId: PublicKey;
  oracleKeypair: Keypair | null;
}

/**
 * Build an Anchor Program instance for runtime use. If `withOracle` is true,
 * the provider is wired with the oracle keypair and can sign transactions
 * (needed by the claim-keeper). Otherwise it uses a read-only wallet.
 */
export function createCovanticProgram(
  config: AppConfig,
  { withOracle }: { withOracle: boolean },
): CovanticProgram {
  const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  const idl = loadIdl();
  const programId = new PublicKey(config.PROGRAM_ID);

  let oracleKeypair: Keypair | null = null;
  let wallet: Wallet;

  if (withOracle) {
    oracleKeypair = loadKeypair(config.ORACLE_KEYPAIR_PATH);
    wallet = new Wallet(oracleKeypair);
  } else {
    wallet = new ReadOnlyWallet();
  }

  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const program = new Program(idl, provider);
  return { program, provider, connection, programId, oracleKeypair };
}
