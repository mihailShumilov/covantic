/**
 * Snapshot the agent fleet: SOL balance, USDC balance, last recorded
 * activity per agent. Read-only; safe to run whenever.
 *
 * Usage:
 *   pnpm fleet:status
 */

import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import Redis from 'ioredis';
import { loadManifest } from '../src/services/fleet/manifest.js';
import {
  FLEET_ACTIVITY_KEY,
  type FleetActivityEntry,
} from '../src/services/fleet/types.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const usdcMint = new PublicKey(requireEnv('USDC_MINT'));
  const redisUrl = requireEnv('REDIS_URL');
  const connection = new Connection(rpcUrl, 'confirmed');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

  const manifest = loadManifest();
  if (manifest.agents.length === 0) {
    console.log('Fleet is empty. Run `pnpm fleet:bootstrap` to populate it.');
    redis.disconnect();
    return;
  }

  const recentRaw = await redis.lrange(FLEET_ACTIVITY_KEY, 0, 200);
  const recent: FleetActivityEntry[] = recentRaw
    .map((r) => {
      try {
        return JSON.parse(r) as FleetActivityEntry;
      } catch {
        return null;
      }
    })
    .filter((r): r is FleetActivityEntry => r !== null);
  const lastByAgent = new Map<string, FleetActivityEntry>();
  for (const entry of recent) {
    if (!lastByAgent.has(entry.agentName)) lastByAgent.set(entry.agentName, entry);
  }

  console.log(`\n=== fleet:status ===`);
  console.log(`  holder: ${manifest.agents[0]?.holderPubkey ?? '(none)'}`);
  console.log(`  count:  ${manifest.agents.length}\n`);

  const rows: Array<{
    name: string;
    pubkey: string;
    sol: string;
    usdc: string;
    tier: number;
    policyId: number;
    lastAction: string;
  }> = [];

  for (const agent of manifest.agents) {
    const pk = new PublicKey(agent.pubkey);
    const sol = await connection.getBalance(pk).catch(() => 0);
    let usdc = 0;
    try {
      const ata = getAssociatedTokenAddressSync(usdcMint, pk);
      const info = await connection.getTokenAccountBalance(ata);
      usdc = Number(info.value.uiAmount ?? 0);
    } catch {
      usdc = 0;
    }
    const last = lastByAgent.get(agent.name);
    const lastAction = last
      ? `${last.kind}${last.amountUi != null ? ` ${last.amountUi.toFixed(2)} USDC` : ''} ${new Date(last.timestamp).toISOString()}`
      : '(no activity yet)';
    rows.push({
      name: agent.name,
      pubkey: agent.pubkey,
      sol: (sol / LAMPORTS_PER_SOL).toFixed(4),
      usdc: usdc.toFixed(2),
      tier: agent.riskTier,
      policyId: agent.policyId,
      lastAction,
    });
  }

  const nameCol = Math.max(...rows.map((r) => r.name.length), 4);
  console.log(
    `  ${'NAME'.padEnd(nameCol)}  ${'TIER'.padStart(4)}  ${'POLICY'.padStart(6)}  ${'SOL'.padStart(8)}  ${'USDC'.padStart(10)}  LAST ACTION`,
  );
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(nameCol)}  ${String(r.tier).padStart(4)}  ${String(r.policyId).padStart(6)}  ${r.sol.padStart(8)}  ${r.usdc.padStart(10)}  ${r.lastAction}`,
    );
  }
  console.log('');

  redis.disconnect();
}

main().catch((err) => {
  console.error('\n✗ fleet:status failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
