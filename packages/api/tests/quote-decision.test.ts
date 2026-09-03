import { describe, expect, it } from 'vitest';
import { RiskTier } from '@covantic/shared';
import { decideQuote, type QuoteDecisionInput } from '../src/services/quote-decision.js';

/**
 * The decisions the quote makes, tested where they are made.
 *
 * Both of these lived inside the request handler as arguments to other
 * functions — a literal `0` passed to `calculatePremium`, and an `if` around a
 * 400 — and nothing could reach either. Removing the zero, or the comparison,
 * left every test in the suite green while the endpoint went back to quoting a
 * policy above the cover it sells.
 */

const usdc = (n: number) => Math.round(n * 1_000_000);

const base = (over: Partial<QuoteDecisionInput> = {}): QuoteDecisionInput => ({
  coverageAmountRaw: usdc(2_000),
  durationSeconds: 3600 * 24 * 7,
  tier: RiskTier.MEDIUM,
  coveredBalanceRaw: usdc(5_000),
  p95OutflowRaw: usdc(20),
  transferCount: 8,
  totalStakedRaw: usdc(40_000),
  totalCoverageRaw: usdc(16_000),
  ...over,
});

describe('what a quote decides', () => {
  it('prices on the tier alone, so the premium stays a fraction of the cover', () => {
    const decision = decideQuote(base());
    if (decision?.kind !== 'priced') throw new Error('expected a price');

    expect(decision.envelopeFlatPremiumRaw).toBe(0);
    expect(decision.premiumRaw).toBeGreaterThan(0);
    expect(decision.premiumRaw).toBeLessThan(usdc(2_000) * 0.01);
  });

  it('does not move the price when the agent is holding far more than its cap', () => {
    // The shape that produced a 2,000.96 quote on 2,000 of cover: an agent
    // holding thousands under a cap of a hundred. What it could be walked over
    // the line for is no longer what it is charged.
    const modest = decideQuote(base({ coveredBalanceRaw: usdc(2_000) }));
    const rich = decideQuote(base({ coveredBalanceRaw: usdc(500_000) }));
    if (modest?.kind !== 'priced' || rich?.kind !== 'priced') throw new Error('expected prices');

    expect(rich.premiumRaw).toBe(modest.premiumRaw);
  });

  it('refuses cover above what the agent holds', () => {
    const decision = decideQuote(base({ coveredBalanceRaw: usdc(800) }));

    expect(decision).toEqual({
      kind: 'refused',
      code: 'COVERAGE_ABOVE_MAX',
      maxCoverageRaw: usdc(800),
      bound: 'agent_balance',
    });
  });

  it('refuses cover the vault’s stake cannot carry, and says which bound bit', () => {
    const decision = decideQuote(
      base({ coveredBalanceRaw: usdc(500_000), totalStakedRaw: usdc(8_500) }),
    );
    if (decision?.kind !== 'refused') throw new Error('expected a refusal');

    // The agent could justify far more; the vault cannot carry it. 2 × 8,500
    // staked against 16,000 already outstanding leaves 1,000.
    expect(decision.bound).toBe('vault_capacity');
    expect(decision.maxCoverageRaw).toBe(usdc(1_000));
  });

  it('sells cover exactly at the bound', () => {
    // The boundary is inclusive on purpose: refusing the maximum the quote
    // itself just advertised would be a form the buyer cannot satisfy.
    const decision = decideQuote(base({ coveredBalanceRaw: usdc(2_000) }));

    expect(decision?.kind).toBe('priced');
  });

  it('returns the envelope the purchase must declare, derived not chosen', () => {
    const decision = decideQuote(base());
    if (decision?.kind !== 'priced') throw new Error('expected a price');

    expect(decision.mandate.maxSingleOutflowRaw).toBe(usdc(100)); // five × 20
    expect(decision.envelopeBasis).toBe('history');
    expect(decision.ordinaryOutflowRaw).toBe(usdc(20));
  });

  it('falls back to the balance for an agent with no habit yet', () => {
    const decision = decideQuote(
      base({ coveredBalanceRaw: usdc(800), coverageAmountRaw: usdc(800), p95OutflowRaw: null, transferCount: 0 }),
    );
    if (decision?.kind !== 'priced') throw new Error('expected a price');

    expect(decision.envelopeBasis).toBe('balance');
    expect(decision.mandate.maxSingleOutflowRaw).toBe(usdc(800));
  });
});
