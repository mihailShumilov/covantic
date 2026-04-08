import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../config/database.js';
import { vaultSnapshots, policies } from '../db/schema.js';
import { logger } from '../utils/logger.js';

const QUEUE_NAME = 'analytics-aggregator';

/** Start the analytics aggregator worker.
 * Creates vault snapshots and aggregates metrics every hour. */
export function startAnalyticsAggregator(db: Database, redis: Redis) {
  const queue = new Queue(QUEUE_NAME, { connection: redis });

  // Schedule recurring job every hour
  queue.upsertJobScheduler('aggregate-analytics', { every: 3_600_000 }, {
    name: 'create-vault-snapshot',
  });

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      logger.debug('Creating vault snapshot...');

      // Count active policies
      const activePoliciesResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(policies)
        .where(eq(policies.state, 0));

      const activePolicies = activePoliciesResult[0]?.count ?? 0;

      // Create snapshot (in production, read actual vault state from on-chain)
      await db.insert(vaultSnapshots).values({
        totalStaked: 0,
        totalCoverage: 0,
        totalPremiums: 0,
        totalClaimsPaid: 0,
        stakerCount: 0,
        solvencyRatio: 0,
        activePolicies,
      });

      logger.info({ activePolicies }, 'Vault snapshot created');
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, error: err }, 'Analytics aggregator job failed');
  });

  return worker;
}
