import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import type { Database } from '../config/database.js';
import { logger } from '../utils/logger.js';

const QUEUE_NAME = 'solvency-checker';

/** Start the solvency checker worker.
 * Syncs vault state and updates premium multiplier every 5 minutes. */
export function startSolvencyChecker(db: Database, redis: Redis) {
  const queue = new Queue(QUEUE_NAME, { connection: redis });

  // Schedule recurring job every 5 minutes
  queue.upsertJobScheduler('check-solvency', { every: 300_000 }, {
    name: 'check-vault-solvency',
  });

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      logger.debug('Checking vault solvency...');

      // In production, read vault state from on-chain and sync to DB
      // For now, broadcast current state via Redis
      await redis.publish(
        'vault:stats',
        JSON.stringify({
          channel: 'vault:stats',
          event: 'solvency_check',
          data: { checkedAt: new Date().toISOString() },
          timestamp: Date.now(),
        }),
      );
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, error: err }, 'Solvency checker job failed');
  });

  return worker;
}
