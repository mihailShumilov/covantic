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
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS claims_open_unique
    ON claims (policy_id)
    WHERE status IN ('pending', 'verifying', 'approved', 'paying')
  `);
  logger.info('Custom constraints applied');
}
