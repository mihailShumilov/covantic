import { describe, expect, it } from 'vitest';
import { MAX_ENVELOPE_SURCHARGE_BPS } from '@covantic/shared';
import {
  FREE_HEADROOM,
  MIN_HEADROOM,
  priceEnvelope,
  type EnvelopePricingInput,
} from '../src/services/envelope-pricing.js';

/**
 * INV-PRICE-01 — a deductible costs what it is worth.
 *
 * The premium priced the agent's risk tier and nothing about the envelope, so
 * a holder could buy cover and *then* declare a cap their agent was certain to
 * cross: 100 USDC on an agent that routinely moves 600, one movement to an
 * address the verifier cannot attribute to them, and the overshoot collected.
 * The movement is real; the loss is not. `isSelf` knows only the holder and
 * agent wallets, and a fresh address reads as foreign.
 *
 * What this prices is **headroom** — how far the declared limit sits above
 * what the agent actually does — because a cap means nothing without the
 * behaviour it bounds. The tests below are about that arithmetic making the
 * manoeuvre unprofitable, not about the specific curve, which is a tunable
 * bound rather than an estimate of anything.
 */

const usdc = (n: number) => n * 1_000_000;

const base = (over: Partial<EnvelopePricingInput> = {}): EnvelopePricingInput => ({
  maxSingleOutflowRaw: usdc(100),
  minRetainedBalanceRaw: 0,
  coveredBalanceRaw: usdc(5_000),
  p95OutflowRaw: usdc(20),
  transferCount: 10,
  ...over,
});

describe('INV-PRICE-01 — the envelope is priced on headroom', () => {
  it('charges nothing when the cap sits well above what the agent does', () => {
    // 100 against a 20 USDC habit: the agent has to behave five times
    // abnormally before the vault owes anything, and a breach there is a
    // genuine anomaly — which is the risk the product exists to carry.
    const priced = priceEnvelope(base());

    expect(priced.kind).toBe('priced');
    expect(priced.kind === 'priced' && priced.surchargeBps).toBe(0);
    expect(priced.kind === 'priced' && priced.headroom).toBe(FREE_HEADROOM);
  });

  it('refuses to attest a cap the agent already crosses in ordinary business', () => {
    // Under one, the claim is not a risk, it is a schedule. No premium prices
    // that correctly, so the honest answer is no — said at the quote, where
    // the holder can widen the envelope, rather than at purchase.
    const refused = priceEnvelope(base({ p95OutflowRaw: usdc(600) }));

    expect(refused.kind).toBe('refused');
    expect(refused.kind === 'refused' && refused.reason).toBe(
      'declared_cap_below_agent_normal_movement',
    );
  });

  it('charges more as the cap tightens toward what the agent does', () => {
    const loose = priceEnvelope(base({ p95OutflowRaw: usdc(25) }));
    const tight = priceEnvelope(base({ p95OutflowRaw: usdc(60) }));

    expect(loose.kind === 'priced' && tight.kind === 'priced').toBe(true);
    if (loose.kind !== 'priced' || tight.kind !== 'priced') return;
    expect(tight.surchargeBps).toBeGreaterThan(loose.surchargeBps);
  });

  it('prices the retention floor, which reads as generous and is not', () => {
    // A floor just below the balance means the next ordinary movement breaches
    // it. Left unpriced it is the same hole in the other dimension: an agent
    // holding 5,000 with a 4,990 floor breaches on a 20 USDC transfer.
    const floored = priceEnvelope(base({ minRetainedBalanceRaw: usdc(4_990) }));

    expect(floored.kind).toBe('refused');
    expect(floored.kind === 'refused' && floored.reason).toBe(
      'declared_floor_leaves_no_room_for_normal_movement',
    );
  });

  it('takes the tighter of the two dimensions', () => {
    // A generous cap does not redeem a suffocating floor, or the other way
    // round: the vault pays on whichever the agent crosses first.
    const looseCap = priceEnvelope(
      base({ maxSingleOutflowRaw: usdc(10_000), minRetainedBalanceRaw: usdc(4_950) }),
    );

    expect(looseCap.kind === 'priced' && looseCap.headroom).toBe(2.5);
  });

  it('charges the ceiling when there is no history to measure against', () => {
    // Not a refusal. A new agent is not a bad risk, it is an unmeasured one,
    // and refusing would make the product unbuyable on day one. The ceiling
    // leaves the holder the option of building a record and quoting again.
    const fresh = priceEnvelope(base({ p95OutflowRaw: null, transferCount: 0 }));

    expect(fresh.kind === 'priced' && fresh.surchargeBps).toBe(MAX_ENVELOPE_SURCHARGE_BPS);
    expect(fresh.kind === 'priced' && fresh.basis).toBe('no_history');
  });

  it('will not read a thin sample as a habit', () => {
    // Two movements do not describe a distribution, and treating them as one
    // is how an agent with a single small transfer gets priced as the safest
    // risk on the book.
    const thin = priceEnvelope(base({ transferCount: 2 }));

    expect(thin.kind === 'priced' && thin.basis).toBe('no_history');
  });

  it('does not read a zero percentile as infinite headroom', () => {
    // The trap in the arithmetic: dividing by zero gives Infinity, which reads
    // as the safest envelope possible for an agent that has moved nothing.
    const zero = priceEnvelope(base({ p95OutflowRaw: 0, transferCount: 50 }));

    expect(zero.kind === 'priced' && zero.basis).toBe('no_history');
  });

  it('never exceeds the ceiling the program will accept', () => {
    // `upsert_attestation` rejects a surcharge above it, so a model that could
    // exceed it would fail at the oracle rather than at the quote.
    for (const p95 of [usdc(20), usdc(50), usdc(99), usdc(100)]) {
      const priced = priceEnvelope(base({ p95OutflowRaw: p95 }));
      if (priced.kind !== 'priced') continue;
      expect(priced.surchargeBps).toBeLessThanOrEqual(MAX_ENVELOPE_SURCHARGE_BPS);
      expect(priced.surchargeBps).toBeGreaterThanOrEqual(0);
    }
    expect(MIN_HEADROOM).toBeLessThan(FREE_HEADROOM);
  });
});
