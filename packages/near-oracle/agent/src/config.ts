/** Runtime configuration, read from the environment in one place. */

export const COVANTIC_PROGRAM_ID = 'HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL';
export const MPC_CONTRACT_ID = 'v1.signer-prod.testnet';
export const ED25519_DOMAIN_ID = 1;
export const DERIVATION_PATH = 'covantic-oracle-v1';
export const TRIGGER_ORACLE_MANIPULATION = 2;

export type AgentMode = 'local' | 'tee';

export interface AgentConfig {
  mode: AgentMode;
  nearRpcUrl: string;
  solanaRpcUrl: string;
  triggerContractId: string;
  stateDir: string;
  /** Token accounts of a staged venue. See `predicate/evidence.ts`. */
  stagedVenues: Set<string>;
  /** Seconds a policy must have been live before a loss counts. */
  waitingWindowSec: number;
  pollIntervalMs: number;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See packages/near-oracle/.env.example`);
  return value;
}

export function loadConfig(): AgentConfig {
  const mode = process.env.AGENT_MODE === 'tee' ? 'tee' : 'local';
  return {
    mode,
    nearRpcUrl: process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com',
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    triggerContractId: requireEnv('TRIGGER_CONTRACT_ID'),
    stateDir: process.env.STATE_DIR || '.state',
    stagedVenues: new Set(
      (process.env.STAGED_VENUES ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    waitingWindowSec: Number(process.env.WAITING_WINDOW_SEC ?? 0),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
  };
}

export function solanaTxLink(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function solanaAddressLink(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

export function nearAccountLink(accountId: string): string {
  return `https://testnet.nearblocks.io/address/${accountId}`;
}

export function nearTxLink(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}
