import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { MAX_CHECKPOINT_AGE_SECONDS } from '@covantic/shared';
import { logger } from '../utils/logger.js';

// Load .env from monorepo root (src/config -> src -> api -> packages -> root)
loadDotenv({ path: resolve(import.meta.dirname, '../../../../.env') });

/**
 * An optional string that treats an empty value as absent.
 *
 * `docker-compose.prod.yml` passes `${VAR:-}` for every optional variable, so
 * an unset one arrives as `''` rather than `undefined` — and `''` satisfies
 * neither `.optional()` nor `.min(n)`. That is not hypothetical: shipping
 * `HELIUS_WEBHOOK_BEARER` in the compose env block without this took the api
 * and monitor containers into a restart loop on the first deploy, because a
 * bearer nobody had set failed `.min(32)`.
 *
 * `USDC_MINT` learned the same lesson earlier. This is that fix, shared, so
 * the next optional variable added to compose inherits it.
 */
function optionalEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4099),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  SOLANA_RPC_URL: z.string().url(),
  /**
   * Extra read-only endpoints, comma-separated, in preference order.
   *
   * Reads fail over across `SOLANA_RPC_URL` plus these; writes stay on
   * `SOLANA_RPC_URL` alone. Empty is legal and means the previous behaviour —
   * one endpoint, and every checkpoint and claim path down with it when that
   * provider hits its quota.
   */
  SOLANA_RPC_FALLBACK_URLS: optionalEnv(
    z
      .string()
      .optional()
    .refine(
      (raw) =>
        !raw ||
        raw
          .split(',')
          .map((u) => u.trim())
          .filter((u) => u.length > 0)
          .every((u) => URL.canParse(u) && new URL(u).protocol === 'https:'),
      // `.url()` on the primary admits `http:` too, but this is the variable
      // an operator adds endpoints to, and every read that reaches a hashed
      // evidence bundle can travel over one of them. Plaintext there is a
      // strictly easier position to reach than compromising a provider.
      { message: 'every entry must be an https URL' },
    ),
  ),
  /**
   * Rank endpoints by how fresh their slot is before each read.
   *
   * Off by default because the kit implements it by probing `getSlot` on every
   * endpoint before every request, multiplying request volume by the endpoint
   * count — the opposite of what a quota-exhausted deployment needs.
   */
  SOLANA_RPC_FRESHNESS_AWARE: z
    .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
    .default(false),
  SOLANA_NETWORK: z.enum(['devnet', 'mainnet-beta', 'localnet']).default('devnet'),
  /**
   * How often the exploit and oracle watchers sweep, in milliseconds.
   *
   * The ceiling is the load-bearing half. The exploit sweep is what writes the
   * on-chain balance checkpoints every proven payout is bounded by, and
   * `verify_and_payout_exploit` refuses a checkpoint older than
   * `MAX_CHECKPOINT_AGE` (2 h). A cadence above that window does not slow
   * detection — it makes every provable claim unprovable, and a payout that
   * reverts is recorded `failed`, a closed status, not `review`. A quarter of
   * the window leaves room for verification latency.
   *
   * Both were read straight from `process.env` with no floor, ceiling or NaN
   * guard, which also meant a bare `EXPLOIT_SWEEP_INTERVAL_MS=` in a copied
   * `.env` became `Number('') === 0` and BullMQ refused to schedule at all.
   */
  EXPLOIT_SWEEP_INTERVAL_MS: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.coerce
        .number()
        .int()
        .min(5_000)
        .max((MAX_CHECKPOINT_AGE_SECONDS * 1000) / 4),
    )
    .default(120_000),
  ORACLE_SWEEP_INTERVAL_MS: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.coerce.number().int().min(5_000).max(1_800_000),
    )
    .default(120_000),

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
   * Route agent-error payouts through `verify_and_payout_agent_error`, which
   * measures the balance drop itself and refuses to pay more than the amount
   * by which it exceeded an operating envelope the holder declared.
   *
   * Defaults to off for the same reason as the other three, plus one that is
   * specific to this path and worth knowing before turning it on. It depends
   * on **both** a holder declaration and a fresh balance checkpoint, and those
   * two fail differently:
   *
   *   - No mandate resolves to `review` before any RPC call, so enabling the
   *     flag early is harmless for policies that have not declared — the same
   *     migration the governance flag has.
   *   - A **missing or stale checkpoint** makes the on-chain call revert, and
   *     the keeper marks a failed payout `failed`, not `review`.
   *
   * So this flag inherits the dangerous half. Do not enable it unless the
   * `exploit-watcher` crank — which writes `checkpoint_balance` — is confirmed
   * running, or valid claims become dead ones.
   */
  AGENT_ERROR_PROOF_ENABLED: z
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

  /**
   * Bearer token for real Helius deliveries, separate from the HMAC key.
   *
   * Helius sends this header verbatim on every delivery, so it is exposed to
   * anything that logs headers. Sharing it with `HELIUS_WEBHOOK_SECRET` meant
   * seeing one leaked both. Optional: falls back to the shared secret, so an
   * existing deployment keeps working until it is set.
   */
  HELIUS_WEBHOOK_BEARER: optionalEnv(z.string().min(32).optional()),

  /**
   * The covered mint. Optional so a bare dev boot works, but never silently
   * discarded: the previous preprocessor mapped *any* value under 32 chars to
   * `undefined`, so the placeholder shipped in `.env.example`
   * (`YOUR_DEVNET_USDC_MINT`, 21 chars) booted clean and disabled the entire
   * agent-error auto-claim path — `screenForMandateBreach` needs a covered
   * mint to find the covered leg, and without one no mandate breach can ever
   * open a claim. A wrong value now fails validation instead.
   */
  USDC_MINT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .min(32, 'USDC_MINT must be a base58 mint address — the .env.example placeholder is not one')
      .max(44)
      .optional(),
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

  // Absence is legal but never silent. Without a covered mint the agent-error
  // screen cannot identify the covered leg, so no mandate breach can open a
  // claim — a whole trigger disabled with nothing in the logs to say so.
  if (!cachedConfig.USDC_MINT) {
    logger.error(
      'USDC_MINT is not set: agent-error claims cannot be opened automatically. ' +
        'Set it to the covered mint address for this cluster.',
    );
  }
  if (cachedConfig.AGENT_ERROR_PROOF_ENABLED && !cachedConfig.USDC_MINT) {
    logger.error('AGENT_ERROR_PROOF_ENABLED is on but USDC_MINT is unset — refusing to start.');
    process.exit(1);
  }

  return cachedConfig;
}
