/** Standalone entry point for the transaction monitor process */
import { loadConfig } from '../config/env.js';
import { createDbConnection } from '../config/database.js';
import { createRedisConnection } from '../config/redis.js';
import { registerWorkers } from './index.js';
import { logger } from '../utils/logger.js';

async function main() {
  const config = loadConfig();
  const db = createDbConnection(config.DATABASE_URL);
  const redis = createRedisConnection(config.REDIS_URL);

  registerWorkers(db, redis, config);

  logger.info('Transaction monitor started');

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('Shutting down monitor...');
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(err, 'Monitor failed to start');
  process.exit(1);
});
