/** Standalone entry point for the transaction monitor process */
import { registerCoveredMint } from '@covantic/shared';
import { loadConfig } from '../config/env.js';
import { createDbConnection } from '../config/database.js';
import { createRedisConnection } from '../config/redis.js';
import { registerWorkers } from './index.js';
import { logger } from '../utils/logger.js';
import { verifyReaderCluster } from '../utils/solana-reader.js';

async function main() {
  const config = loadConfig();
  // Same reason as in the API entrypoint: the monitor runs the verifiers too,
  // and an unregistered covered mint makes every loss unpriceable.
  registerCoveredMint(config.USDC_MINT);
  const db = createDbConnection(config.DATABASE_URL);
  const redis = createRedisConnection(config.REDIS_URL);

  // The monitor is the process that writes the balance checkpoints every
  // proven payout is bounded by, so a wrong-cluster endpoint here is worse
  // than in the API: it would silently stop checkpointing.
  await verifyReaderCluster(config);

  registerWorkers(db, redis, config);

  logger.info('Transaction monitor started');

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('Shutting down monitor...');
    process.exit(0);
  });
}

/**
 * The same guard the API has, for the same reason.
 *
 * The monitor is the process that writes the balance checkpoints every proven
 * payout is bounded by, so a restart here is worse than in the API: a gap in
 * checkpointing is a window where an incident produces an uncompensated loss.
 * A rate-limited RPC call must not open one. See the note in `index.ts`.
 */
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason : new Error(String(reason)) },
    'unhandled promise rejection — monitor continues',
  );
});

main().catch((err) => {
  logger.error(err, 'Monitor failed to start');
  process.exit(1);
});
