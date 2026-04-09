import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { desc, sql, eq } from 'drizzle-orm';
import type { Database } from '../config/database.js';
import { vaultSnapshots, policies } from '../db/schema.js';
import { logger } from '../utils/logger.js';

const QUEUE_NAME = 'solvency-checker';

/** Start the solvency checker worker.
 * Syncs vault state and snapshots metrics every 5 minutes. */
export function startSolvencyChecker(db: Database, redis: Redis) {
  const queue = new Queue(QUEUE_NAME, { connection: redis });

  queue.upsertJobScheduler(
    'check-solvency',
    { every: 300_000 },
    {
      name: 'check-vault-solvency',
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      logger.debug('Checking vault solvency...');

      // Aggregate on-chain-like stats from DB
      const [activePolicies, latestSnapshot] = await Promise.all([
        db
          .select({
            totalCoverage: sql<number>`coalesce(sum(coverage_amount), 0)`,
            totalPremiums: sql<number>`coalesce(sum(premium_paid), 0)`,
            count: sql<number>`count(*)`,
          })
          .from(policies)
          .where(eq(policies.state, 0)),
        db.select().from(vaultSnapshots).orderBy(desc(vaultSnapshots.snapshotAt)).limit(1),
      ]);

      const prev = latestSnapshot[0];
      const totalCoverage = Number(activePolicies[0]?.totalCoverage ?? 0);
      const totalStaked = prev?.totalStaked ?? 0;
      const solvencyRatio = totalCoverage > 0 ? Math.round((totalStaked / totalCoverage) * 10000) : 20000;

      // Insert new snapshot
      await db.insert(vaultSnapshots).values({
        totalStaked,
        totalCoverage,
        totalPremiums: Number(activePolicies[0]?.totalPremiums ?? 0),
        totalClaimsPaid: prev?.totalClaimsPaid ?? 0,
        stakerCount: prev?.stakerCount ?? 0,
        solvencyRatio,
        activePolicies: Number(activePolicies[0]?.count ?? 0),
        snapshotAt: new Date(),
      });

      // Broadcast via Redis for WebSocket clients
      await redis.publish(
        'vault:stats',
        JSON.stringify({
          channel: 'vault:stats',
          event: 'solvency_check',
          data: { solvencyRatio, totalStaked, totalCoverage, checkedAt: new Date().toISOString() },
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
