/**
 * Prints the Solana address the contract controls, whether it is funded, and
 * the exact admin command that makes it the Covantic oracle. It never runs
 * that command and never reads an admin key.
 */
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { DERIVATION_PATH, loadConfig, solanaAddressLink } from '../agent/src/config.js';
import { log, step } from '../agent/src/log.js';
import { deriveOracleAddress } from '../agent/src/near/client.js';
import { CovanticProgram } from '../agent/src/solana/program.js';

const MIN_ORACLE_SOL = 0.05;

const config = loadConfig();
const oracle = await deriveOracleAddress(config.nearRpcUrl, config.triggerContractId, DERIVATION_PATH);
const connection = new Connection(config.solanaRpcUrl, 'confirmed');
const balance = (await connection.getBalance(oracle)) / LAMPORTS_PER_SOL;
const { oracleAuthority } = await new CovanticProgram(connection).readConfig();

step('Oracle address (devnet)');
log(`contract ${config.triggerContractId}`);
log(`path     ${DERIVATION_PATH}`);
log(`address  ${oracle.toBase58()}`);
log(`explorer ${solanaAddressLink(oracle.toBase58())}`);
log(`balance  ${balance} SOL`);

if (balance < MIN_ORACLE_SOL) {
  step('Fund it');
  log('The public devnet airdrop is closed, so send SOL from any devnet wallet:');
  log(`  solana transfer ${oracle.toBase58()} 0.1 --allow-unfunded-recipient --url devnet`);
}

step('Current on-chain oracle');
log(`config.oracle_authority ${oracleAuthority.toBase58()}`);
if (oracleAuthority.equals(oracle)) {
  log('The contract already controls the oracle role.');
} else {
  log('\nThe Covantic admin runs this. While it is in force, the old oracle key stops working:');
  log(`  pnpm admin:set-oracle ${oracle.toBase58()} --keypair <path-to-admin-keypair>`);
  log('\nTo restore the current oracle afterwards:');
  log(`  pnpm admin:set-oracle ${oracleAuthority.toBase58()} --keypair <path-to-admin-keypair>`);
}
