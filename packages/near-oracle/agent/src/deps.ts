import { Connection, PublicKey } from '@solana/web3.js';
import { COVANTIC_PROGRAM_ID, loadConfig, requireEnv } from './config.js';
import { createWorker } from './near/client.js';
import { buildPriceOracle } from './pipeline.js';
import type { AgentDeps } from './pipeline.js';
import { CovanticProgram } from './solana/program.js';
import { SolanaRpc } from './solana/rpc.js';
import { loadOrCreateFunder } from './state.js';

/** Wires the agent from the environment. Used by the service and the demos. */
export async function createAgent(): Promise<AgentDeps> {
  const config = loadConfig();
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  const program = new CovanticProgram(connection);
  if (program.programId.toBase58() !== COVANTIC_PROGRAM_ID) {
    throw new Error('the bundled IDL names a different program');
  }
  const { usdcMint } = await program.readConfig();
  return {
    config,
    connection,
    program,
    rpc: new SolanaRpc(config.solanaRpcUrl),
    priceOracle: buildPriceOracle(),
    worker: await createWorker(config),
    oracleAddress: new PublicKey(requireEnv('ORACLE_ADDRESS')),
    coveredMint: usdcMint,
    relayer: loadOrCreateFunder(config.stateDir),
  };
}
