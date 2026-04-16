import { createHmac, timingSafeEqual } from 'node:crypto';
import type Redis from 'ioredis';

export const ALERT_CHANNEL = 'monitoring:alerts';

/**
 * Internal alert bus. Publishers and consumers of `monitoring:alerts`
 * must go through this module so every message is HMAC-signed. Prevents
 * a Redis-level attacker (compromised container, misconfigured firewall)
 * from injecting synthetic alerts that would drive the oracle-signed
 * claim pipeline.
 */

interface SignedEnvelope {
  v: 1;
  /** Unix epoch millis when the message was produced */
  t: number;
  /** SHA-256 hex HMAC over `${t}.${payload}` */
  sig: string;
  /** JSON-encoded payload */
  payload: string;
}

/** Maximum age of a signed alert before it is rejected as replay. */
const MAX_AGE_MS = 60_000;

function sign(secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function publishAlert(
  redis: Redis,
  secret: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const t = Date.now();
  const body = JSON.stringify(payload);
  const envelope: SignedEnvelope = {
    v: 1,
    t,
    sig: sign(secret, t, body),
    payload: body,
  };
  await redis.publish(ALERT_CHANNEL, JSON.stringify(envelope));
}

export interface VerifiedAlert<T = unknown> {
  payload: T;
  timestamp: number;
}

/** Verify a wire message from `monitoring:alerts`. Returns null when the
 *  envelope is malformed, the signature is wrong, or the message is
 *  older than MAX_AGE_MS. */
export function verifyAlert<T = unknown>(
  raw: string,
  secret: string,
): VerifiedAlert<T> | null {
  let envelope: SignedEnvelope;
  try {
    envelope = JSON.parse(raw) as SignedEnvelope;
  } catch {
    return null;
  }
  if (envelope?.v !== 1 || typeof envelope.t !== 'number' ||
      typeof envelope.sig !== 'string' || typeof envelope.payload !== 'string') {
    return null;
  }
  if (Math.abs(Date.now() - envelope.t) > MAX_AGE_MS) {
    return null;
  }
  const expected = sign(secret, envelope.t, envelope.payload);
  if (!timingSafeEqualHex(expected, envelope.sig)) {
    return null;
  }
  try {
    return { payload: JSON.parse(envelope.payload) as T, timestamp: envelope.t };
  } catch {
    return null;
  }
}
