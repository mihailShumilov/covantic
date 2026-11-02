/**
 * Points `config.oracle_authority` at a new address. For the Covantic admin to
 * run by hand: the keypair path comes from the command line and the agent never
 * has it. Devnet only.
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { solanaTxLink } from '../agent/src/config.js';
import { log } from '../agent/src/log.js';
import { CovanticProgram } from '../agent/src/solana/program.js';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const [target, flag, keypairPath] = process.argv.slice(2);
if (!target || flag !== '--keypair' || !keypairPath) {
  throw new Error('usage: pnpm admin:set-oracle <address> --keypair <path-to-admin-keypair>');
}

const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8')) as number[]),
);
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const program = new CovanticProgram(connection);
const instruction = await program.updateOracle(admin.publicKey, new PublicKey(target));
const signature = await connection.sendTransaction(new Transaction().add(instruction), [admin]);
await connection.confirmTransaction(signature, 'confirmed');
const { oracleAuthority } = await program.readConfig();
log(`config.oracle_authority is now ${oracleAuthority.toBase58()}`);
log(solanaTxLink(signature));
