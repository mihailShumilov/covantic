import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit bundles this file as CJS, so `import.meta` is unavailable.
// pnpm invokes the script with cwd = package root, so walk up two levels.
loadDotenv({ path: resolve(process.cwd(), '../../.env') });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
