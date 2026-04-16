import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

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
  // The /api/monitoring/webhook endpoint rejects all requests that don't
  // carry a matching HMAC, so the server must refuse to start without this
  // secret. Require 64+ chars so a 32-byte hex/Base64 secret is enforced.
  HELIUS_WEBHOOK_SECRET: z.string().min(64),
  // HMAC secret used to sign messages on the `monitoring:alerts` Redis
  // channel. The claim-keeper refuses to act on an unsigned or mismatched
  // alert, so any internal process publishing to this channel must share
  // this secret.
  ALERT_HMAC_SECRET: z.string().min(32),

  USDC_MINT: z.preprocess(
    (v) => (typeof v === 'string' && v.length >= 32 ? v : undefined),
    z.string().min(32).optional(),
  ),

  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? undefined : v)),
});

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    logger.error({ issues: result.error.format() }, 'Invalid environment variables');
    process.exit(1);
  }
  cachedConfig = result.data;
  return cachedConfig;
}
