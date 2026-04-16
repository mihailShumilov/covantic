import type { Database } from '../config/database.js';
import type Redis from 'ioredis';
import { logger } from '../utils/logger.js';

/**
 * Analytics aggregator — deliberately disabled.
 *
 * The previous implementation inserted a zeroed vault snapshot every hour
 * ({totalStaked:0, totalCoverage:0, ...}), corrupting the history that
 * `solvency-checker` already writes every 5 minutes from on-chain state.
 *
 * Until we have a real analytics rollup (e.g., policy activity counters,
 * claim frequency) this worker is a no-op. Kept as a named export so the
 * worker registry import site doesn't churn, and so the shape is obvious
 * when we wire real aggregations in.
 */
export function startAnalyticsAggregator(_db: Database, _redis: Redis) {
  logger.info('analytics-aggregator: disabled (solvency-checker owns vault snapshots)');
  return null;
}
