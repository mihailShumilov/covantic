import type Redis from 'ioredis';
import type { AppConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * A cap on how much the protocol will pay automatically in a rolling window.
 *
 * Every other control in the claim pipeline reasons about one claim: was this
 * movement authorised, does this price deviate, is this drop real. Each is a
 * bound on a single decision, and each can be wrong. This is the control that
 * survives one of them being wrong — because the failure that actually
 * destroys a vault is not one bad payout, it is the same bad payout repeated
 * a hundred times before anyone looks.
 *
 * Cheap to build, and it makes every other bound survivable. When it trips,
 * claims queue to review rather than closing: a paused payout is a delay, and
 * a wrongly rejected claim is a loss the policyholder cannot appeal.
 */

const WINDOW_SEC = 3_600;
const KEY = 'covantic:payouts:auto:hourly';

export interface BreakerVerdict {
  ok: boolean;
  reason: string;
  detail: Record<string, unknown>;
}

const PASS: BreakerVerdict = { ok: true, reason: 'within_limits', detail: {} };

/**
 * May this payout go out automatically?
 *
 * Fails **open** on a Redis outage, and that direction is deliberate and
 * worth arguing with. The breaker is a backstop against a systematic error,
 * not a component of the correctness argument — every payout that reaches it
 * has already cleared the confidence lane and, where enabled, the chain's own
 * measurement. Blocking every payout because a cache is down would convert an
 * infrastructure blip into a protocol-wide outage, which is the larger harm.
 */
export async function checkCircuitBreaker(
  redis: Redis,
  config: AppConfig,
  payoutAmount: number,
): Promise<BreakerVerdict> {
  const limit = config.AUTO_PAYOUT_HOURLY_LIMIT_RAW;
  if (!limit || limit <= 0) return PASS;

  let spent = 0;
  try {
    spent = Number((await redis.get(KEY)) ?? 0);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'payout-breaker: window unreadable, allowing payout',
    );
    return PASS;
  }
  if (!Number.isFinite(spent)) spent = 0;

  const projected = spent + payoutAmount;
  if (projected > limit) {
    return {
      ok: false,
      reason: 'auto_payout_limit_exceeded',
      detail: { spent, payoutAmount, projected, limit, windowSec: WINDOW_SEC },
    };
  }

  return PASS;
}

/** Count a payout against the window. Called only after it lands on chain. */
export async function recordAutoPayout(redis: Redis, payoutAmount: number): Promise<void> {
  try {
    const total = await redis.incrby(KEY, payoutAmount);
    // Set the expiry only when the window opens, so a steady stream of
    // payouts cannot keep pushing the reset out and hide a runaway hour.
    if (total === payoutAmount) await redis.expire(KEY, WINDOW_SEC);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'payout-breaker: failed to record payout against the window',
    );
  }
}

export { WINDOW_SEC as PAYOUT_WINDOW_SEC };
