import { describe, expect, it } from 'vitest';
import { priceEnvelope } from '../src/services/envelope-pricing.js';

/**
 * Why capping the payout at the premium costs an honest holder nothing.
 *
 * The cap in `verify_and_payout_agent_error` looks blunt — a payout that
 * cannot exceed what was paid in reads like no cover at all. It is not, and
 * the reason is arithmetic rather than policy.
 *
 * The largest breach the program can ever *prove* against an agent holding B,
 * under a declared cap C and retention floor F, is:
 *
 *   - crossing the cap:  the agent cannot move more than it holds, so the
 *                        overshoot is at most B − C
 *   - crossing the floor: the balance cannot go below zero, so the shortfall
 *                        is at most min(F, B)
 *
 * — which is `max(B − C, min(F, B))`, and that is exactly the quantity the
 * pricing calls reachable and charges for, flat, at purchase. So the flat
 * premium already covers any breach provable against the balance the agent
 * held when the policy was bought.
 *
 * The cap therefore bites in exactly one case: the agent came to hold *more*
 * than it did at purchase. That is the top-up, it is the hole the cap exists
 * to close, and it is not a case any honest claim falls into.
 *
 * This is the load-bearing claim, so it is checked against the real pricing
 * across the shapes rather than argued in a comment.
 */

const P95 = 20_000_000; // 20 USDC, the agent's ordinary movement
const COVERAGE = 2_000_000_000;

function maxProvableBreach(balance: number, cap: number, floor: number): number {
  return Math.max(Math.max(0, balance - cap), Math.min(floor, balance));
}

describe('the flat premium covers every breach provable at purchase', () => {
  // Two regimes, and both have to hold.
  //
  // Where the declared cap sits close to what the agent normally does, the
  // price is set by that habit and dwarfs the extractable amount — the claim
  // is true there but says little. The shapes that actually test it are the
  // ones with room to spare (a cap at five times the ordinary movement or
  // more), where the habit half is free and the extractable amount is the
  // whole price. Those are marked `binds`.
  const shapes = [
    // --- the extractable amount is the entire premium ---
    { name: 'binds: a cap under the balance, with room above ordinary movement', balance: 500_000_000, cap: 100_000_000, floor: 0 },
    { name: 'binds: a retention floor and an unreachable cap', balance: 500_000_000, cap: 1_000_000_000, floor: 100_000_000 },
    { name: 'binds: reachable beyond the coverage bought', balance: 3_000_000_000, cap: 200_000_000, floor: 0 },
    { name: 'binds: cap and floor both reachable, cap the wider', balance: 500_000_000, cap: 100_000_000, floor: 50_000_000 },
    { name: 'binds: nothing reachable at all', balance: 100_000_000, cap: 500_000_000, floor: 0 },
    { name: 'binds: cap exactly at the balance', balance: 100_000_000, cap: 100_000_000, floor: 0 },
    // --- the habit half dominates, or the envelope is refused outright ---
    { name: 'a retention floor close to the balance', balance: 100_000_000, cap: 500_000_000, floor: 40_000_000 },
    { name: 'both declared tight', balance: 100_000_000, cap: 95_000_000, floor: 60_000_000 },
    { name: 'a floor above the balance', balance: 10_000_000, cap: 500_000_000, floor: 90_000_000 },
    { name: 'an empty agent', balance: 0, cap: 10_000_000, floor: 5_000_000 },
  ];


  for (const shape of shapes) {
    it(`covers it: ${shape.name}`, () => {
      const quote = priceEnvelope({
        coverageAmountRaw: COVERAGE,
        coveredBalanceRaw: shape.balance,
        maxSingleOutflowRaw: shape.cap,
        minRetainedBalanceRaw: shape.floor,
        p95OutflowRaw: P95,
        transferCount: 8,
      });

      if (quote.kind === 'refused') return; // no policy sold, nothing to cover

      // Coverage bounds the payout on its own, so the claim is about what the
      // policy can actually pay, not about the raw size of the movement.
      const payable = Math.min(COVERAGE, maxProvableBreach(shape.balance, shape.cap, shape.floor));
      // The whole point: the premium is enough to pay any breach the program
      // could prove against the balance this was priced on.
      expect(quote.flatPremiumRaw).toBeGreaterThanOrEqual(payable);
    });
  }

  it('and stops covering as soon as the agent is topped up — which is the case the cap is for', () => {
    // The envelope that is genuinely healthy at purchase: a 500 cap over an
    // agent that holds 400 and ordinarily moves 20. Nothing is reachable —
    // the agent cannot move more than it has — so the envelope is free, and
    // correctly so.
    const quote = priceEnvelope({
      coverageAmountRaw: COVERAGE,
      coveredBalanceRaw: 400_000_000,
      maxSingleOutflowRaw: 500_000_000,
      minRetainedBalanceRaw: 0,
      p95OutflowRaw: P95,
      transferCount: 8,
    });
    if (quote.kind !== 'priced') throw new Error('expected a quote');
    expect(quote.flatPremiumRaw).toBe(0);
    expect(maxProvableBreach(400_000_000, 500_000_000, 0)).toBe(0);

    // Then fund the same agent to 5000. The cap did not move and neither did
    // the premium, but 4500 is now reachable — bounded only by the coverage
    // the holder bought for nothing. Nothing reprices, because the price was
    // set at purchase; the payout cap is the only thing that answers this.
    const afterTopUp = Math.min(COVERAGE, maxProvableBreach(5_000_000_000, 500_000_000, 0));
    expect(afterTopUp).toBeGreaterThan(quote.flatPremiumRaw);
  });
});
