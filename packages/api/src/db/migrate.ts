import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { logger } from '../utils/logger.js';

const MIGRATIONS_FOLDER = './src/db/migrations';

export async function runMigrations(databaseUrl: string): Promise<void> {
  if (!existsSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`)) {
    logger.info('No migrations folder found — use "pnpm db:push" to sync schema');
    return;
  }

  logger.info('Running database migrations...');

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    logger.info('Migrations completed successfully');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    throw error;
  } finally {
    await pool.end();
  }
}
