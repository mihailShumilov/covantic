import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { lt, eq, and } from 'drizzle-orm';
import type { Database } from '../config/database.js';
import { policies } from '../db/schema.js';
import { logger } from '../utils/logger.js';

const QUEUE_NAME = 'expiry-crank';

/** Start the policy expiry crank worker.
 * Checks for expired policies every minute and updates their state. */
export function startExpiryCrank(db: Database, redis: Redis) {
  const queue = new Queue(QUEUE_NAME, { connection: redis });

  // Schedule recurring job every 60 seconds
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

      // Find active policies past their expiry time
      const expired = await db
        .select()
        .from(policies)
        .where(and(eq(policies.state, 0), lt(policies.expiryTime, now)));

      if (expired.length === 0) {
        return;
      }

      // Mark them as expired (state = 4)
      for (const policy of expired) {
        await db
          .update(policies)
          .set({ state: 4, updatedAt: new Date() })
          .where(eq(policies.policyId, policy.policyId));

        logger.info({ policyId: policy.policyId }, 'Policy expired');
      }

      logger.info({ count: expired.length }, 'Expired policies processed');
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, error: err }, 'Expiry crank job failed');
  });

  return worker;
}
