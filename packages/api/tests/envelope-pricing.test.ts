import { describe, expect, it } from 'vitest';
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
  coverageAmountRaw: usdc(2_000),
  maxSingleOutflowRaw: usdc(100),
  minRetainedBalanceRaw: 0,
  coveredBalanceRaw: usdc(5_000),
  p95OutflowRaw: usdc(20),
  transferCount: 10,
  ...over,
});

describe('INV-PRICE-01 — the envelope is priced on headroom', () => {
  it('charges nothing when the cap is out of the agent’s reach entirely', () => {
    // Habits do not enter into it: an agent holding 5,000 cannot move 10,000,
    // so a 10,000 cap carries no exposure at all. This is the case that used
    // to cost a full ceiling surcharge for want of a history.
    const priced = priceEnvelope(base({ maxSingleOutflowRaw: usdc(10_000) }));

    expect(priced.kind === 'priced' && priced.flatPremiumRaw).toBe(0);
  });

  it('charges the whole coverage when the whole coverage can be taken at will', () => {
    // The manoeuvre this exists to make pointless: an agent holding 5,000 with
    // a 100 cap can be walked over the line for 4,900, bounded by the 2,000
    // coverage — the entire policy, collectable on demand. Paying the entire
    // coverage as premium is what removes the profit.
    const priced = priceEnvelope(base({ p95OutflowRaw: usdc(20), transferCount: 50 }));

    // The whole coverage, flat. Not a rate: a rate divided by the tenor, and a
    // one-hour policy then bought this ability for 0.23 USDC.
    expect(priced.kind === 'priced' && priced.flatPremiumRaw).toBe(usdc(2_000));
  });

  it('takes the worse of habit and opportunity', () => {
    // A comfortable headroom does not excuse an envelope that can be walked
    // over deliberately. Here the agent's habits are five times inside the
    // cap — free, on the history model alone — and the balance still lets the
    // holder take the whole policy.
    const priced = priceEnvelope(base({ p95OutflowRaw: usdc(20), transferCount: 50 }));

    expect(priced.kind === 'priced' && priced.headroom).toBe(FREE_HEADROOM);
    expect(priced.kind === 'priced' && priced.flatPremiumRaw).toBeGreaterThan(0);
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
    // The cap sits just under the balance, so almost nothing is extractable
    // on demand and the habit half of the model is what shows. With a cap far
    // below the balance both cases would sit at the ceiling on opportunity
    // alone and the gradient would be invisible — which is correct pricing and
    // a useless test.
    const nearBalance = { maxSingleOutflowRaw: usdc(4_900), transferCount: 50 };
    const loose = priceEnvelope(base({ ...nearBalance, p95OutflowRaw: usdc(1_225) }));
    const tight = priceEnvelope(base({ ...nearBalance, p95OutflowRaw: usdc(2_450) }));

    expect(loose.kind === 'priced' && tight.kind === 'priced').toBe(true);
    if (loose.kind !== 'priced' || tight.kind !== 'priced') return;
    expect(tight.flatPremiumRaw).toBeGreaterThan(loose.flatPremiumRaw);
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

  it('prices a brand-new agent on its balance rather than charging the ceiling', () => {
    // What the holder can take is measurable without any history, and an
    // envelope the agent cannot cross carries no exposure however new it is.
    // Charging the ceiling for want of a record priced an unmeasured agent as
    // though it were a hostile one — a fleet agent's first week cost forty
    // times the tier premium for cover it could not have claimed on.
    const fresh = priceEnvelope(
      base({ p95OutflowRaw: null, transferCount: 0, maxSingleOutflowRaw: usdc(10_000) }),
    );

    expect(fresh.kind === 'priced' && fresh.flatPremiumRaw).toBe(0);
    expect(fresh.kind === 'priced' && fresh.basis).toBe('balance');
  });

  it('still charges a brand-new agent whose envelope can be walked over', () => {
    // The other half of the same rule: no history is not a discount either.
    const fresh = priceEnvelope(base({ p95OutflowRaw: null, transferCount: 0 }));

    expect(fresh.kind === 'priced' && fresh.flatPremiumRaw).toBe(usdc(2_000));
  });

  it('will not read a thin sample as a habit', () => {
    // Two movements do not describe a distribution, and treating them as one
    // is how an agent with a single small transfer gets priced as the safest
    // risk on the book.
    const thin = priceEnvelope(base({ transferCount: 2 }));

    expect(thin.kind === 'priced' && thin.basis).toBe('balance');
  });

  it('does not read a zero percentile as infinite headroom', () => {
    // The trap in the arithmetic: dividing by zero gives Infinity, which reads
    // as the safest envelope possible for an agent that has moved nothing.
    const zero = priceEnvelope(base({ p95OutflowRaw: 0, transferCount: 50 }));

    expect(zero.kind === 'priced' && zero.basis).toBe('balance');
  });

  it('never exceeds the coverage, which the program refuses above', () => {
    // `create_policy` rejects a flat premium larger than the coverage, so a
    // model that could exceed it would fail at the purchase rather than at the
    // quote. The coverage is also the true bound: the policy cannot pay more
    // than it covers, so nothing beyond it is extractable.
    for (const p95 of [usdc(20), usdc(50), usdc(99), usdc(100)]) {
      const priced = priceEnvelope(base({ p95OutflowRaw: p95 }));
      if (priced.kind !== 'priced') continue;
      expect(priced.flatPremiumRaw).toBeLessThanOrEqual(usdc(2_000));
      expect(priced.flatPremiumRaw).toBeGreaterThanOrEqual(0);
    }
    expect(MIN_HEADROOM).toBeLessThan(FREE_HEADROOM);
  });

  it('does not let the tenor undercut it', () => {
    // The defect this shape exists to prevent, stated as a property: the price
    // of the envelope is the same whether the policy runs an hour or a month,
    // because the ability it prices is available in the first minute of both.
    const priced = priceEnvelope(base({ p95OutflowRaw: usdc(20), transferCount: 50 }));

    expect(priced.kind === 'priced' && priced.flatPremiumRaw).toBe(usdc(2_000));
  });
});
