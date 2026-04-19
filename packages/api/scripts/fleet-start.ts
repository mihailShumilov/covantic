/**
 * Run the agent fleet. Spawns one async loop per agent and keeps them all
 * acting indefinitely until SIGINT / SIGTERM.
 *
 * Each loop does:
 *   1. Roll an action (safe / skip / rogue) according to the agent's
 *      behavior profile.
 *   2. Execute it (SPL USDC transfer, or an intentionally oversize memo tx
 *      for the `fail` variant).
 *   3. Append an activity record to the Redis list `covantic:fleet:activity`
 *      (capped at 500) so the /api/fleet endpoint + dashboard can surface it.
 *   4. Sleep a jittered 45–90 s and repeat.
 *
 * Usage:
 *   pnpm fleet:start
 *
 * Bootstrap the fleet first with `pnpm fleet:bootstrap`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import Redis from 'ioredis';
import {
  FLEET_ACTIVITY_CAP,
  FLEET_ACTIVITY_KEY,
  type FleetActivityEntry,
  type FleetAgent,
} from '../src/services/fleet/types.js';
import { DEFAULT_PROFILE } from '../src/services/fleet/types.js';
import { loadManifest } from '../src/services/fleet/manifest.js';
import {
  rollJitterMs,
  runOneAction,
  type ActionContext,
  type ActionResult,
} from '../src/services/fleet/actions.js';
import { logger } from '../src/utils/logger.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  const abs = path.startsWith('/') ? path : resolve(REPO_ROOT, path);
  const secret = JSON.parse(readFileSync(abs, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function pushActivity(
  redis: Redis,
  entry: FleetActivityEntry,
): Promise<void> {
  try {
    await redis
      .multi()
      .lpush(FLEET_ACTIVITY_KEY, JSON.stringify(entry))
      .ltrim(FLEET_ACTIVITY_KEY, 0, FLEET_ACTIVITY_CAP - 1)
      .exec();
  } catch (err) {
    // Don't let a Redis blip stop the runner.
    logger.warn({ err }, 'fleet: failed to push activity');
  }
}

function activityFromResult(
  agent: FleetAgent,
  result: ActionResult,
): FleetActivityEntry {
  const base = {
    timestamp: Date.now(),
    agentName: agent.name,
    agentPubkey: agent.pubkey,
  } as const;
  if (result.kind === 'skip') return { ...base, kind: 'skip' };
  if (result.kind === 'fail') {
    return {
      ...base,
      kind: 'fail',
      signature: result.signature,
      error: result.error,
      onChainErr: result.onChainErr,
      failureKind: result.failureKind,
    };
  }
  return {
    ...base,
    kind: result.kind === 'large' ? 'large' : 'safe',
    amountUi: result.amountUi,
    signature: result.signature,
  };
}

async function runAgentLoop(
  agent: FleetAgent,
  keypair: Keypair,
  connection: Connection,
  usdcMint: PublicKey,
  sink: PublicKey,
  redis: Redis,
  stopSignal: { stopped: boolean },
): Promise<void> {
  const profile = agent.profile ?? DEFAULT_PROFILE;
  // Stagger the initial sleep so N agents don't all fire their first tick
  // in the same second — makes the feed feel less synchronized.
  const initial = Math.floor(Math.random() * rollJitterMs());
  await sleep(initial, stopSignal);
  while (!stopSignal.stopped) {
    const started = Date.now();
    const ctx: ActionContext = {
      connection,
      agent: keypair,
      sink,
      usdcMint,
    };
    let result: ActionResult;
    try {
      result = await runOneAction(ctx, profile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ agent: agent.name, err: msg }, 'fleet: action threw');
      result = { kind: 'skip', error: msg };
      await pushActivity(redis, {
        timestamp: Date.now(),
        agentName: agent.name,
        agentPubkey: agent.pubkey,
        kind: 'error',
        error: msg,
      });
    }
    if (result.kind !== 'skip' || result.error) {
      const entry = activityFromResult(agent, result);
      await pushActivity(redis, entry);
    }
    logger.info(
      {
        agent: agent.name,
        kind: result.kind,
        amountUi: result.amountUi,
        sig: result.signature,
        err: result.error,
        onChainErr: result.onChainErr,
        failureKind: result.failureKind,
        elapsedMs: Date.now() - started,
      },
      `fleet: tick`,
    );
    await sleep(rollJitterMs(), stopSignal);
  }
}

async function sleep(ms: number, stopSignal: { stopped: boolean }): Promise<void> {
  // Break the sleep into 1 s chunks so SIGINT kills the process promptly.
  const chunk = 1_000;
  const end = Date.now() + ms;
  while (!stopSignal.stopped && Date.now() < end) {
    const remaining = end - Date.now();
    await new Promise((r) => setTimeout(r, Math.min(chunk, remaining)));
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('fleet:start refuses to run with NODE_ENV=production');
  }
  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const usdcMint = new PublicKey(requireEnv('USDC_MINT'));
  const redisUrl = requireEnv('REDIS_URL');
  const connection = new Connection(rpcUrl, 'confirmed');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

  // Sink = oracle keypair's pubkey. It has an ATA by construction (it's
  // the mint authority) so transfers always settle without a pre-init.
  const oracleAuthority = loadKeypair(requireEnv('ORACLE_KEYPAIR_PATH'));
  const sink = oracleAuthority.publicKey;

  const stopSignal = { stopped: false };
  const shutdown = () => {
    if (stopSignal.stopped) return;
    console.log('\n↓ shutting down fleet (waiting for in-flight ticks)…');
    stopSignal.stopped = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Wait for the manifest to become non-empty. This makes the script safe
  // to include in `pnpm dev`: if no one has bootstrapped yet, we idle
  // instead of crashing the dev stack. Re-reads every 10s so a later
  // `pnpm fleet:bootstrap` can hand us work without a restart.
  let manifest = loadManifest();
  if (manifest.agents.length === 0) {
    console.log(
      `\n=== fleet:start ===\n  fleet manifest is empty; idling until \`pnpm fleet:bootstrap\` populates it.\n  rpc: ${rpcUrl}\n`,
    );
    while (!stopSignal.stopped && manifest.agents.length === 0) {
      await new Promise((r) => setTimeout(r, 10_000));
      manifest = loadManifest();
    }
    if (stopSignal.stopped) {
      redis.disconnect();
      return;
    }
  }

  console.log(`\n=== fleet:start ===`);
  console.log(`  agents: ${manifest.agents.length}`);
  console.log(`  rpc:    ${rpcUrl}`);
  console.log(`  sink:   ${sink.toBase58()}\n`);

  const loops = manifest.agents.map((agent) => {
    const keypairPath = resolve(REPO_ROOT, 'keys/agents', `${agent.name}.json`);
    const keypair = loadKeypair(keypairPath);
    return runAgentLoop(agent, keypair, connection, usdcMint, sink, redis, stopSignal);
  });
  await Promise.all(loops);

  redis.disconnect();
  console.log('↓ fleet stopped.');
}

main().catch((err) => {
  console.error('\n✗ fleet:start failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
