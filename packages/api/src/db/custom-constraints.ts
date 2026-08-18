import { sql } from 'drizzle-orm';
import type { Database } from '../config/database.js';
import { logger } from '../utils/logger.js';

/**
 * Idempotent DDL for constraints that drizzle-kit can't express natively.
 * Runs after migrations/push on every boot. Each statement must use
 * `IF NOT EXISTS` so repeated boots are safe.
 */
export async function applyCustomConstraints(db: Database): Promise<void> {
  // Partial unique index: at most one open claim per policy. Prevents the
  // check-then-insert race window in claim-keeper's ingest path.
  //
  // `indeterminate` and `review` are open states: a claim awaiting a retry or
  // an adjuster still occupies the policy. Leaving them out would let a
  // second alert open a duplicate claim while the first is mid-retry.
  // Keep this list in sync with OPEN_CLAIM_STATUSES in @covantic/shared.
  //
  // The index is recreated rather than left alone, because CREATE ... IF NOT
  // EXISTS silently keeps an older predicate — which is exactly how a stale
  // definition would survive this change unnoticed.
  await db.execute(sql`DROP INDEX IF EXISTS claims_open_unique`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS claims_open_unique
    ON claims (policy_id)
    WHERE status IN ('pending', 'verifying', 'approved', 'paying', 'indeterminate', 'review')
  `);
  logger.info('Custom constraints applied');
}
