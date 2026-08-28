import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import type { AppConfig } from '../src/config/env.js';
import { checkCircuitBreaker, recordAutoPayout } from '../src/services/payout-breaker.js';

function fakeRedis(initial: number | null = null) {
  const state = { value: initial, expiry: null as number | null, expireCalls: 0 };
  const redis = {
    get: async () => (state.value === null ? null : String(state.value)),
    incrby: async (_key: string, by: number) => {
      state.value = (state.value ?? 0) + by;
      return state.value;
    },
    expire: async (_key: string, sec: number) => {
      state.expiry = sec;
      state.expireCalls += 1;
      return 1;
    },
  } as unknown as Redis;
  return { redis, state };
}

const config = (limit: number) => ({ AUTO_PAYOUT_HOURLY_LIMIT_RAW: limit }) as AppConfig;

describe('automatic payout circuit breaker', () => {
  it('allows a payout inside the window', async () => {
    const { redis } = fakeRedis(10_000);
    const verdict = await checkCircuitBreaker(redis, config(100_000), 50_000);

    expect(verdict.ok).toBe(true);
  });

  it('blocks the payout that would cross the cap', async () => {
    const { redis } = fakeRedis(80_000);
    const verdict = await checkCircuitBreaker(redis, config(100_000), 50_000);

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('auto_payout_limit_exceeded');
    expect(verdict.detail).toMatchObject({ spent: 80_000, projected: 130_000 });
  });

  it('is disabled by a zero limit', async () => {
    const { redis } = fakeRedis(999_999);
    expect((await checkCircuitBreaker(redis, config(0), 1_000)).ok).toBe(true);
  });

  it('fails open when the window cannot be read', async () => {
    // A cache outage must not become a protocol-wide payout outage. Every
    // payout reaching here already cleared the confidence lane and, where
    // enabled, the chain's own measurement.
    const redis = {
      get: async () => {
        throw new Error('redis down');
      },
    } as unknown as Redis;

    expect((await checkCircuitBreaker(redis, config(100_000), 1_000)).ok).toBe(true);
  });

  it('sets the expiry once so a steady stream cannot hide a runaway hour', async () => {
    const { redis, state } = fakeRedis(null);

    await recordAutoPayout(redis, 1_000);
    await recordAutoPayout(redis, 1_000);
    await recordAutoPayout(redis, 1_000);

    expect(state.value).toBe(3_000);
    expect(state.expireCalls).toBe(1);
  });

  it('treats a corrupted counter as an empty window rather than a block', async () => {
    const redis = { get: async () => 'not-a-number' } as unknown as Redis;

    expect((await checkCircuitBreaker(redis, config(100_000), 1_000)).ok).toBe(true);
  });
});
