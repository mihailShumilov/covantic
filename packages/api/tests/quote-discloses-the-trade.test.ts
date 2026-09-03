import { describe, expect, it } from 'vitest';
import { calculatePremium } from '@covantic/shared';
import { RiskTier } from '@covantic/shared';
import { COVERAGE, DURATION } from '@covantic/shared';

/**
 * INV-PRICE-01 — a premium is a fraction of the cover, never a multiple of it.
 *
 * This is the property that broke, so it is the property that gets a test.
 *
 * The envelope used to carry a flat charge equal to what the holder could move
 * past their own declared cap. While the holder chose that cap there was no
 * honest alternative — an envelope drawn tight around the agent's balance is
 * a scheduled claim, and the only price that covers it is the whole thing. The
 * arithmetic was right and the product was absurd: a policy quoted at 2,000.96
 * to insure 2,000.
 *
 * Two changes removed the need for it. The envelope is derived from the
 * agent's own record rather than chosen, so there is no cap to draw tight; and
 * an agent-error payout cannot exceed the premium, so extraction cannot profit
 * whatever the envelope looks like. What is left is a rate on the cover for a
 * term — which is what a premium is.
 */

const usdc = (n: number) => Math.round(n * 1_000_000);

const TIERS = [RiskTier.LOW, RiskTier.MEDIUM, RiskTier.HIGH];

describe('INV-PRICE-01 — the premium stays a fraction of the cover', () => {
  const coverages = [COVERAGE.MIN, usdc(100), usdc(2_000), usdc(50_000), COVERAGE.MAX];
  const durations = [DURATION.MIN, 3600 * 24, 3600 * 24 * 7, DURATION.MAX];

  for (const tier of TIERS) {
    for (const coverage of coverages) {
      for (const duration of durations) {
        it(`tier ${tier}, ${coverage / 1_000_000} USDC over ${Math.round(duration / 3600)}h`, () => {
          const premium = calculatePremium(coverage, duration, tier, 10000, 0);

          expect(premium).not.toBeNull();
          expect(premium as number).toBeLessThan(coverage);
        });
      }
    }
  }

  it('is far below the cover even at the worst combination the domain allows', () => {
    // The maximum rate over the maximum term: HIGH is 500 bps annual and the
    // longest policy is 30 days, so the ceiling is about 0.41% of the cover.
    // Stated as a bound rather than an equality, so a tier change fails this
    // for the right reason.
    const premium = calculatePremium(usdc(10_000), DURATION.MAX, RiskTier.HIGH, 10000, 0);

    expect(premium as number).toBeLessThan(usdc(10_000) * 0.01);
  });

  it('still charges something — a free policy is not the fix for an expensive one', () => {
    const premium = calculatePremium(usdc(2_000), 3600 * 24 * 7, RiskTier.MEDIUM, 10000, 0);

    expect(premium as number).toBeGreaterThan(0);
  });

  it('would breach the property if the envelope were charged again', () => {
    // The guard on the change rather than a restatement of it: feeding the old
    // flat charge back in reproduces the quote that started this, so the test
    // fails if anything ever puts it back.
    const coverage = usdc(2_000);
    const asItWas = calculatePremium(coverage, 3600 * 24 * 7, RiskTier.MEDIUM, 10000, coverage);

    expect(asItWas as number).toBeGreaterThan(coverage);
  });
});
