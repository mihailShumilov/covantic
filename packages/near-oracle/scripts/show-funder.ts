/** Prints the demo funder's public address and what it holds. */
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { log } from '../agent/src/log.js';
import { CovanticProgram } from '../agent/src/solana/program.js';
import { loadOrCreateFunder } from '../agent/src/state.js';

const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  'confirmed',
);
const funder = loadOrCreateFunder(process.env.STATE_DIR || '.state');
const { usdcMint } = await new CovanticProgram(connection).readConfig();
const usdc = getAssociatedTokenAddressSync(usdcMint, funder.publicKey);
const account = await connection.getAccountInfo(usdc);
const usdcBalance = account
  ? (await connection.getTokenAccountBalance(usdc)).value.uiAmountString
  : '0';

log(`funder ${funder.publicKey.toBase58()}`);
log(`SOL    ${(await connection.getBalance(funder.publicKey)) / LAMPORTS_PER_SOL}`);
log(`USDC   ${usdcBalance} (mint ${usdcMint.toBase58()})`);
