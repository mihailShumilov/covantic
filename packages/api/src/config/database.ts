import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../db/schema.js';

export function createDbConnection(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDbConnection>;
