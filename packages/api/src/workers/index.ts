import type Redis from 'ioredis';
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { startExpiryCrank } from './expiry-crank.js';
import { startSolvencyChecker } from './solvency-checker.js';
import { startAnalyticsAggregator } from './analytics-aggregator.js';
import { logger } from '../utils/logger.js';

export function registerWorkers(db: Database, redis: Redis, _config: AppConfig) {
  logger.info('Starting background workers...');

  startExpiryCrank(db, redis);
  startSolvencyChecker(db, redis);
  startAnalyticsAggregator(db, redis);

  logger.info('All background workers started');
}
