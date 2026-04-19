/**
 * Sync the Helius webhook to watch every insured agent address in the DB.
 *
 * Usage:
 *   pnpm webhook:sync
 *
 * Behavior:
 *   - Reads distinct agent_address values from the `policies` table where
 *     state = 0 (Active). Adding Active-only is deliberate: once a policy
 *     expires or is paid out, there's no reason to stream its events.
 *   - Calls Helius v0/webhooks with the configured WEBHOOK_PUBLIC_URL +
 *     HELIUS_WEBHOOK_SECRET (as the Authorization bearer token Helius
 *     will send back on every delivery).
 *   - Creates the webhook if none exists, edits it otherwise. Idempotent.
 *
 * Required env:
 *   HELIUS_API_KEY          — Helius account API key
 *   HELIUS_WEBHOOK_SECRET   — secret Helius will send as Authorization
 *   WEBHOOK_PUBLIC_URL      — publicly reachable URL to
 *                             <public>/api/monitoring/webhook (e.g. ngrok)
 *   DATABASE_URL, REDIS_URL
 */

import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(import.meta.dirname, '../../../.env') });

import { sql } from 'drizzle-orm';
import { PolicyState } from '@covantic/shared';
import { createDbConnection } from '../src/config/database.js';
import { createRedisConnection } from '../src/config/redis.js';
import { policies } from '../src/db/schema.js';
import { syncWebhook, WEBHOOK_ID_CACHE_KEY } from '../src/services/helius-webhook.js';
import { logger } from '../src/utils/logger.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

async function main() {
  const heliusApiKey = requireEnv('HELIUS_API_KEY');
  const webhookSecret = requireEnv('HELIUS_WEBHOOK_SECRET');
  const webhookPublicUrl = requireEnv('WEBHOOK_PUBLIC_URL');
  const databaseUrl = requireEnv('DATABASE_URL');
  const redisUrl = requireEnv('REDIS_URL');
  const network = (process.env.SOLANA_NETWORK ?? 'devnet') as 'devnet' | 'mainnet-beta';

  // Normalize: Helius wants the receiver URL, not a host. We always route
  // to the API's /api/monitoring/webhook path regardless of what the user
  // supplied — missing path is the most common misconfiguration.
  const endpoint = new URL('/api/monitoring/webhook', webhookPublicUrl).toString();

  const db = createDbConnection(databaseUrl);
  const redis = createRedisConnection(redisUrl);

  try {
    const rows = await db
      .selectDistinct({ agentAddress: policies.agentAddress })
      .from(policies)
      .where(sql`${policies.state} = ${PolicyState.Active}`);
    const agentAddresses = rows.map((r) => r.agentAddress).filter((a) => a && a.length > 0);

    logger.info(
      { count: agentAddresses.length, endpoint, network },
      'helius-sync: collected insured agents',
    );

    const cachedWebhookId = await redis.get(WEBHOOK_ID_CACHE_KEY);
    const result = await syncWebhook({
      heliusApiKey,
      webhookSecret,
      webhookPublicUrl: endpoint,
      network,
      agentAddresses,
      cachedWebhookId,
    });

    if (result.webhookId) {
      await redis.set(WEBHOOK_ID_CACHE_KEY, result.webhookId);
    }

    logger.info(
      {
        action: result.action,
        webhookId: result.webhookId,
        addressCount: result.addressCount,
        added: result.addressesAdded.length,
        removed: result.addressesRemoved.length,
      },
      'helius-sync: done',
    );

    if (result.addressesAdded.length > 0) {
      logger.info({ added: result.addressesAdded }, 'helius-sync: addresses added');
    }
    if (result.addressesRemoved.length > 0) {
      logger.info({ removed: result.addressesRemoved }, 'helius-sync: addresses removed');
    }

    // Handy for piping into .env or a deploy log.
    console.log(JSON.stringify(result, null, 2));
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'helius-sync: failed');
  console.error(err);
  process.exit(1);
});
