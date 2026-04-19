import { describe, expect, it } from 'vitest';
import {
  rollAction,
  rollJitterMs,
  rollLargeAmountUi,
  rollRogue,
  rollSafeAmountUi,
} from '../src/services/fleet/actions.js';
import { DEFAULT_PROFILE, type BehaviorProfile } from '../src/services/fleet/types.js';

/**
 * Statistical sanity checks for the action roller. We use 10 000-sample
 * Monte Carlo runs with Math.random (not seeded) and allow generous
 * tolerances — the goal is "weights are respected", not exact matches.
 */

function distribution(n: number, fn: () => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) {
    const k = fn();
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

describe('rollAction', () => {
  it('respects the 80/15/5 default profile within 2 percentage points', () => {
    const N = 10_000;
    const counts = distribution(N, () => rollAction(DEFAULT_PROFILE));
    expect((counts.safe ?? 0) / N).toBeGreaterThan(0.78);
    expect((counts.safe ?? 0) / N).toBeLessThan(0.82);
    expect((counts.skip ?? 0) / N).toBeGreaterThan(0.13);
    expect((counts.skip ?? 0) / N).toBeLessThan(0.17);
    expect((counts.rogue ?? 0) / N).toBeGreaterThan(0.03);
    expect((counts.rogue ?? 0) / N).toBeLessThan(0.07);
  });

  it('is deterministic with a seeded RNG', () => {
    const seed = seededRng(42);
    const profile: BehaviorProfile = {
      safe: 1,
      skip: 0,
      rogue: 0,
      rogueMix: { sendLarge: 1, failTx: 0 },
    };
    for (let i = 0; i < 100; i += 1) {
      expect(rollAction(profile, seed)).toBe('safe');
    }
  });
});

describe('rollRogue', () => {
  it('picks sendLarge 60% of the time by default', () => {
    const N = 10_000;
    const counts = distribution(N, () => rollRogue(DEFAULT_PROFILE));
    expect((counts.large ?? 0) / N).toBeGreaterThan(0.55);
    expect((counts.large ?? 0) / N).toBeLessThan(0.65);
  });

  it('falls back to failTx when sendLarge weight is 0', () => {
    const profile: BehaviorProfile = {
      safe: 0,
      skip: 0,
      rogue: 1,
      rogueMix: { sendLarge: 0, failTx: 1 },
    };
    for (let i = 0; i < 50; i += 1) {
      expect(rollRogue(profile)).toBe('fail');
    }
  });
});

describe('rollJitterMs', () => {
  it('stays within the 45-90 s window', () => {
    for (let i = 0; i < 1_000; i += 1) {
      const ms = rollJitterMs();
      expect(ms).toBeGreaterThanOrEqual(45_000);
      expect(ms).toBeLessThanOrEqual(90_000);
    }
  });
});

describe('rollSafeAmountUi / rollLargeAmountUi', () => {
  it('safe amounts stay well below 100 USDC', () => {
    for (let i = 0; i < 500; i += 1) {
      const a = rollSafeAmountUi();
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(50);
    }
  });

  it('large amounts exceed the 1,000 USDC monitor threshold', () => {
    for (let i = 0; i < 500; i += 1) {
      const a = rollLargeAmountUi();
      expect(a).toBeGreaterThan(1_000);
      expect(a).toBeLessThanOrEqual(3_000);
    }
  });
});

// Simple mulberry32 PRNG — deterministic, enough for "same seed produces
// same sequence" tests without pulling in a dependency.
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
