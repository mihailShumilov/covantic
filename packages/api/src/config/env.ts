import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load .env from monorepo root (src/config -> src -> api -> packages -> root)
loadDotenv({ path: resolve(import.meta.dirname, '../../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4099),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  SOLANA_RPC_URL: z.string().url(),
  SOLANA_NETWORK: z.enum(['devnet', 'mainnet-beta', 'localnet']).default('devnet'),
  PROGRAM_ID: z.string().min(32),
  ORACLE_KEYPAIR_PATH: z.string(),

  HELIUS_API_KEY: z.string().min(10),
  HELIUS_WEBHOOK_SECRET: z.string().optional(),

  USDC_MINT: z.preprocess(
    (v) => (typeof v === 'string' && v.length >= 32 ? v : undefined),
    z.string().min(32).optional(),
  ),
});

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }
  cachedConfig = result.data;
  return cachedConfig;
}
