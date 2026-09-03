import { describe, expect, it } from 'vitest';
import { priceEnvelope, type EnvelopePricingInput } from '../src/services/envelope-pricing.js';

/**
 * INV-DISCLOSE-01 — the quote says what the policy can pay, not only what it
 * costs.
 *
 * The two are usually the same number. What a holder can walk their agent over
 * its own cap for is both what the premium charges *and* the ceiling on what a
 * breach can recover, because the payout is the overshoot and the overshoot is
 * bounded by what the agent holds above the cap.
 *
 * Neither figure is guessable from the coverage field. A buyer who asks for
 * 2,000 of cover on an agent holding 700 under a 650 cap can be paid at most
 * 50, and is charged for exactly that — so the remaining 1,950 is tier premium
 * on cover no breach of this envelope can reach. Saying so at the quote is the
 * difference between a considered decision and a surprise in the claim.
 */

const usdc = (n: number) => n * 1_000_000;

const base = (over: Partial<EnvelopePricingInput> = {}): EnvelopePricingInput => ({
  coverageAmountRaw: usdc(2_000),
  maxSingleOutflowRaw: usdc(650),
  minRetainedBalanceRaw: 0,
  coveredBalanceRaw: usdc(700),
  p95OutflowRaw: usdc(5),
  transferCount: 10,
  ...over,
});

describe('INV-DISCLOSE-01 — a buyer can see the trade at the quote', () => {
  it('reports the ceiling on a payout, which the coverage does not give', () => {
    // 2,000 of cover asked for; 50 is what any breach of this envelope can
    // actually reach.
    const priced = priceEnvelope(base());

    expect(priced.kind === 'priced' && priced.maxClaimableRaw).toBe(usdc(50));
  });

  it('reports it as the same number the premium charges', () => {
    // Not a coincidence worth hiding: the amount a holder could take at will
    // is the amount they are charged for the ability.
    const priced = priceEnvelope(base());
    if (priced.kind !== 'priced') throw new Error('expected a price');

    expect(priced.flatPremiumRaw).toBe(priced.maxClaimableRaw);
  });

  it('separates the two when the agent’s habits, not its balance, set the price', () => {
    // A cap that sits inside the agent's ordinary movements is priced on the
    // likelihood of an accidental breach, which can exceed what the envelope
    // physically exposes. Reporting that higher figure as claimable would be a
    // lie in the buyer's favour, and then a shortfall in the claim.
    const priced = priceEnvelope(base({ p95OutflowRaw: usdc(400), transferCount: 50 }));
    if (priced.kind !== 'priced') throw new Error('expected a price');

    expect(priced.flatPremiumRaw).toBeGreaterThan(priced.maxClaimableRaw);
    expect(priced.maxClaimableRaw).toBe(usdc(50));
  });

  it('measures the unreachable coverage before the coverage bound', () => {
    // `headroomAboveCapRaw` is what a breach can reach regardless of how much
    // cover was requested; the route subtracts it from the coverage to show
    // what is being paid for and cannot be claimed.
    const priced = priceEnvelope(base());

    expect(priced.kind === 'priced' && priced.headroomAboveCapRaw).toBe(usdc(50));
  });

  it('reports nothing unreachable when the envelope exposes more than the cover', () => {
    // An agent holding far more than its cap can overshoot past the whole
    // policy, so every USDC of coverage is claimable and the warning must stay
    // quiet.
    const priced = priceEnvelope(base({ coveredBalanceRaw: usdc(9_000) }));
    if (priced.kind !== 'priced') throw new Error('expected a price');

    // Strictly greater, and that matters: `headroomAboveCapRaw` is what the
    // envelope exposes *before* the coverage bound, so bounding it by the
    // coverage would make the "unreachable" figure always zero and the warning
    // never fire. An earlier version of this assertion said `>=` and a
    // mutation slipped straight through it.
    expect(priced.headroomAboveCapRaw).toBeGreaterThan(usdc(2_000));
    expect(priced.maxClaimableRaw).toBe(usdc(2_000));
  });

  it('passes the balance through, so the arithmetic can be checked', () => {
    const priced = priceEnvelope(base());

    expect(priced.kind === 'priced' && priced.coveredBalanceRaw).toBe(usdc(700));
  });
});
