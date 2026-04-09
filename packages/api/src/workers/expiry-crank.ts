import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { lt, eq, and } from 'drizzle-orm';
import type { Database } from '../config/database.js';
import { policies } from '../db/schema.js';
import { logger } from '../utils/logger.js';

const QUEUE_NAME = 'expiry-crank';

/** Start the policy expiry crank worker.
 * Checks for expired policies every minute and updates their state in batch. */
export function startExpiryCrank(db: Database, redis: Redis) {
  const queue = new Queue(QUEUE_NAME, { connection: redis });

  queue.upsertJobScheduler(
    'check-expired',
    { every: 60_000 },
    {
      name: 'check-expired-policies',
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const now = new Date();
      logger.debug('Checking for expired policies...');

      // Batch update all expired policies in a single query
      const result = await db
        .update(policies)
        .set({ state: 4, updatedAt: now })
        .where(and(eq(policies.state, 0), lt(policies.expiryTime, now)))
        .returning({ policyId: policies.policyId });

      if (result.length > 0) {
        logger.info({ count: result.length }, 'Expired policies processed');
      }
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, error: err }, 'Expiry crank job failed');
  });

  return worker;
}
