import { describe, expect, it } from 'vitest';
import { evaluate } from '../agent/src/predicate/evaluate.js';
import type { EvaluateInput } from '../agent/src/predicate/evaluate.js';
import { adjudicate, bundleHash } from '../agent/src/predicate/baseline.js';
import { BLOCK_TIME, mkBundle, mkPolicy } from './fixtures/bundle.js';

function input(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    bundle: mkBundle(),
    policy: mkPolicy(),
    nowSec: BLOCK_TIME + 60,
    waitingWindowSec: 0,
    ...overrides,
  };
}

const orderSizeFinding = (depthShare: number) => ({
  findings: [
    { id: 'venue_depth_self_inflicted', present: true, weight: 0.2, detail: { depthShare } },
  ],
  present: ['reference_held_while_fill_diverged'],
  unevaluated: [],
  score: 0.4,
  referenceVolatility: 0.001,
  referenceDriftRatio: 0.01,
  sampledAt: [BLOCK_TIME - 60, BLOCK_TIME + 60],
});

describe('evaluate', () => {
  it('pays a fill far from an agreed reference, bounded by what the chain can prove', () => {
    const result = evaluate(input());
    expect(result.verdict).toBe('PAY');
    if (result.verdict !== 'PAY') return;
    expect(result.inputs.feedIdHex).toBe(mkPolicy().terms?.feedIdHex);
    expect(result.inputs.payoutAmount).toBe(BigInt(adjudicate(mkBundle()).lossAmount));
    expect(result.inputs.payoutAmount).toBeLessThanOrEqual(40_000_000n);
    expect(result.evidence_hash).toBe(bundleHash(mkBundle() as unknown as Record<string, unknown>));
  });

  it('gives the same verdict for the same evidence', () => {
    expect(evaluate(input())).toEqual(evaluate(input()));
  });

  it('refuses a loss the order itself caused', () => {
    const bundle = mkBundle({ signatures: orderSizeFinding(0.6) } as never);
    const result = evaluate(input({ bundle }));
    expect(result).toMatchObject({
      verdict: 'NO_PAY',
      reason: 'slippage_explained_by_order_size',
      retryable: false,
    });
  });

  it('stays open when there is no manipulation signature', () => {
    const signatures = { ...orderSizeFinding(0), findings: [], present: [] };
    const result = evaluate(input({ bundle: mkBundle({ signatures } as never) }));
    expect(result).toMatchObject({ verdict: 'NO_PAY', retryable: true });
  });

  it.each([
    ['policy is not active', { policy: mkPolicy({ state: 2 }) }, 'policy_not_active'],
    ['policy has expired', { nowSec: BLOCK_TIME + 3_601 }, 'policy_expired'],
    [
      'another agent traded',
      { policy: mkPolicy({ agent: 'SomeoneElse' }) },
      'trigger_tx_not_from_covered_agent',
    ],
    [
      'loss came before the policy',
      { policy: mkPolicy({ startTime: BLOCK_TIME + 1 }) },
      'loss_before_waiting_window',
    ],
    ['waiting window not over', { waitingWindowSec: 3_601 }, 'loss_before_waiting_window'],
    [
      'policy has no price terms',
      { policy: mkPolicy({ terms: null }) },
      'policy_has_no_price_terms',
    ],
    [
      'feed differs from the terms',
      { policy: mkPolicy({ terms: { ...mkPolicy().terms!, feedIdHex: '00'.repeat(32) } }) },
      'feed_differs_from_policy_terms',
    ],
    [
      'quantity above the terms',
      { policy: mkPolicy({ terms: { ...mkPolicy().terms!, maxSubjectQuantity: 1n } }) },
      'quantity_above_policy_terms',
    ],
  ])('refuses when the %s', (_label, overrides, reason) => {
    expect(evaluate(input(overrides))).toMatchObject({ verdict: 'NO_PAY', reason });
  });

  it('never pays more than the coverage', () => {
    const result = evaluate(input({ policy: mkPolicy({ coverageRaw: 1_000_000 }) }));
    expect(result).toMatchObject({ verdict: 'PAY' });
    if (result.verdict === 'PAY') expect(result.inputs.payoutAmount).toBe(1_000_000n);
  });
});
