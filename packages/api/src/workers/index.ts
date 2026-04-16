import type Redis from 'ioredis';
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { startExpiryCrank } from './expiry-crank.js';
import { startSolvencyChecker } from './solvency-checker.js';
import { startAnalyticsAggregator } from './analytics-aggregator.js';
import { startPolicyIndexer } from './policy-indexer.js';
import { startClaimKeeper } from './claim-keeper.js';
import { logger } from '../utils/logger.js';

export function registerWorkers(db: Database, redis: Redis, config: AppConfig) {
  logger.info('Starting background workers...');

  startExpiryCrank(db, redis);
  startSolvencyChecker(db, redis, config);
  startAnalyticsAggregator(db, redis);
  startPolicyIndexer(db, redis, config);
  startClaimKeeper(db, redis, config);

  logger.info('All background workers started');
}
