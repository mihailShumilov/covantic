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

  /**
   * Settle oracle-manipulation payouts through `verify_and_payout_v2`, which
   * makes the program verify a guardian-signed Pyth price instead of taking
   * the oracle's word for it.
   *
   * Defaults to off because the instruction only exists in program builds
   * from this change forward — enabling it against an older deployment makes
   * every payout fail. Turn it on after redeploying, and expect claims that
   * cannot be proven to go to review rather than falling back to the
   * unverified path.
   */
  ORACLE_PROOF_ENABLED: z
    .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
    .default(false),
  /**
   * Route exploit payouts through `verify_and_payout_exploit`, which bounds
   * the payout by a balance drop the program measures for itself.
   *
   * Defaults to off for the same reason as ORACLE_PROOF_ENABLED: the
   * instruction only exists in program builds from this change forward, and
   * enabling it against an older deployment makes every exploit payout fail.
   * Turn it on after redeploying. Once on, an exploit claim that cannot be
   * proven goes to review rather than falling back to the unverified path —
   * a fallback would make the whole mechanism decorative.
   */
  EXPLOIT_PROOF_ENABLED: z
    .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
    .default(false),
  /**
   * Route governance payouts through `verify_and_payout_governance`, which
   * compares the holder's own matured declaration of who may control the
   * agent against what the program reads on the account now.
   *
   * Defaults to off for the same reason as the other two, plus one specific
   * to this path: it also requires the holder to have declared a baseline. A
   * policy with no declaration resolves to review whether the flag is on or
   * off, so turning it on changes nothing for existing policies until they
   * declare — which is the intended migration, not a bug.
   */
  GOVERNANCE_PROOF_ENABLED: z
    .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
    .default(false),
  /**
   * Cap on automatic payouts in a rolling hour, in USDC lamports. Zero
   * disables the breaker.
   *
   * This is the control that survives one of the per-claim bounds being
   * wrong: the failure that destroys a vault is not one bad payout, it is the
   * same bad payout repeated before anyone looks. Claims over the cap queue
   * to review rather than closing.
   */
  AUTO_PAYOUT_HOURLY_LIMIT_RAW: z.coerce.number().int().nonnegative().default(100_000_000_000),
  PROGRAM_ID: z.string().min(32),
  ORACLE_KEYPAIR_PATH: z.string(),

  HELIUS_API_KEY: z.string().min(10),
  // The /api/monitoring/webhook endpoint rejects all requests that don't
  // carry a matching HMAC or a matching static bearer token, so the server
  // must refuse to start without this secret. Require 64+ chars so a
  // 32-byte hex/Base64 secret is enforced.
  HELIUS_WEBHOOK_SECRET: z.string().min(64),
  // Public URL where Helius can deliver webhooks (e.g.
  // `https://my-tunnel.ngrok.io`). Only required when running
  // `pnpm webhook:sync` — the API boot flow tolerates it missing so a
  // dev can start the stack without a tunnel.
  WEBHOOK_PUBLIC_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => (v == null || v === '' ? undefined : v)),
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
