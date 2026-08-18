import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADJUDICATOR_VERSION, adjudicate } from '../src/services/oracle/adjudicate.js';
import { bundleHash, verdictHash } from '../src/services/oracle/hash.js';
import type { EvidenceBundle, PricePoint } from '../src/services/oracle/types.js';
import type { LegValuation } from '../src/services/oracle/valuation.js';

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SOL_FEED_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const BLOCK_TIME = 1_700_000_000;

function pythPoint(value: number): PricePoint {
  return {
    value,
    conf: 0.05,
    publishTime: BLOCK_TIME,
    slot: 123,
    source: 'pyth',
    feedId: SOL_FEED_HEX,
    raw: 'ab01',
  };
}

function solLeg(amountUi: number, priceUsd: number): LegValuation {
  return {
    mint: WRAPPED_SOL,
    symbol: 'wSOL',
    amountUi,
    priceUsd,
    confPerUnitUsd: 0.05,
    valueUsd: amountUi * priceUsd,
    confUsd: amountUi * 0.05,
    feedKey: 'SOL/USD',
    source: 'consensus',
    parFallback: false,
    sourceCount: 4,
    dispersion: 0.001,
  };
}

function usdcLeg(amountUi: number): LegValuation {
  return {
    mint: USDC_MINT,
    symbol: 'USDC-dev',
    amountUi,
    priceUsd: 1,
    confPerUnitUsd: 0.0005,
    valueUsd: amountUi,
    confUsd: amountUi * 0.0005,
    feedKey: 'USDC/USD',
    source: 'consensus',
    parFallback: false,
    sourceCount: 3,
    dispersion: 0.001,
  };
}

/** A complete bundle: agent paid 250 USDC for 1 SOL worth 200. */
function mkBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const anchor = { ...pythPoint(200), source: 'consensus' as const, feedId: 'SOL/USD' };
  return {
    version: '1.4.0',
    stage: 'verify',
    triggerType: 2,
    txSignature: 'SigAdjudicate',
    agentAddress: 'AgentWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    coverageRaw: 1_000 * 10 ** 6,
    slot: 987_654,
    blockTime: BLOCK_TIME,
    prices: [pythPoint(200)],
    windows: {
      'consensus:SOL/USD': {
        feedId: 'SOL/USD',
        source: 'consensus',
        targetTime: BLOCK_TIME,
        before: null,
        after: null,
        anchor,
        skewSec: 0,
        contributors: [pythPoint(200)],
        dispersion: 0.001,
        sourceCount: 4,
        missing: [],
      },
    },
    execution: {
      shape: 'swap',
      sold: [{ mint: USDC_MINT, amountUi: 250, decimals: 6 }],
      bought: [{ mint: WRAPPED_SOL, amountUi: 1, decimals: 9 }],
      feeLamports: 5_000,
      droppedSolDustLamports: 0,
    },
    valuation: { sold: [usdcLeg(250)], bought: [solLeg(1, 200)] },
    signatures: {
      findings: [],
      present: ['reference_held_while_fill_diverged'],
      unevaluated: [{ id: 'pool_displacement', reason: 'needs_archival_pool_state' }],
      score: 0.4,
      referenceVolatility: 0.001,
      referenceDriftRatio: 0.01,
      sampledAt: [BLOCK_TIME - 60, BLOCK_TIME + 60],
    },
    collectedAt: 1_700_000_500_000,
    ...overrides,
  };
}

describe('adjudicate — purity', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Any network access inside the adjudicator would make a verdict depend
    // on the world at scoring time, which is exactly what replay must not do.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('adjudicate must not perform I/O');
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('reaches a verdict without touching the network', () => {
    const verdict = adjudicate(mkBundle());
    expect(verdict.outcome).toBe('confirmed');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns an identical verdict on repeated calls', () => {
    const bundle = mkBundle();
    expect(adjudicate(bundle)).toEqual(adjudicate(bundle));
  });

  it('does not read the clock', () => {
    const bundle = mkBundle();
    const early = adjudicate(bundle);

    // Move the world forward by a year. A verdict that depends on "now"
    // cannot be replayed, and a stale price would silently become a fresh one.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
      expect(adjudicate(bundle)).toEqual(early);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is unaffected by when the evidence was collected', () => {
    const a = adjudicate(mkBundle({ collectedAt: 1 }));
    const b = adjudicate(mkBundle({ collectedAt: 9_999_999_999 }));
    expect(a).toEqual(b);
  });

  it('produces a stable verdict hash for the same evidence', () => {
    const bundle = mkBundle();
    const hashOnce = verdictHash(
      bundleHash(bundle as unknown as Record<string, unknown>),
      adjudicate(bundle),
    );
    const replay = mkBundle({ stage: 'replay', collectedAt: 42 });
    const hashAgain = verdictHash(
      bundleHash(replay as unknown as Record<string, unknown>),
      adjudicate(replay),
    );
    expect(hashAgain).toBe(hashOnce);
  });
});

describe('adjudicate — judgement', () => {
  it('subtracts the honest cost of trading', () => {
    const verdict = adjudicate(mkBundle());
    expect(verdict.details.shortfallUsd).toBeCloseTo(50, 6);
    expect(verdict.details.expectedCostUsd).toBeCloseTo(0.75, 6);
    expect(verdict.lossAmount).toBe(49_250_000);
  });

  it('caps the loss at the policy coverage', () => {
    const verdict = adjudicate(mkBundle({ coverageRaw: 10 * 10 ** 6 }));
    expect(verdict.lossAmount).toBe(10 * 10 ** 6);
  });

  it('escalates rather than guessing when the bundle is incomplete', () => {
    // An older bundle replayed against a newer adjudicator must say "cannot
    // tell", not produce a confident answer from absent evidence.
    const verdict = adjudicate(mkBundle({ valuation: undefined }));
    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('incomplete_evidence_bundle');
  });

  it('escalates when no manipulation signature was observed', () => {
    const verdict = adjudicate(
      mkBundle({
        signatures: {
          findings: [],
          present: [],
          unevaluated: [],
          score: 0,
          referenceVolatility: 0.001,
          referenceDriftRatio: 2,
          sampledAt: [],
        },
      }),
    );
    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('no_manipulation_signature');
  });

  it('rejects when volatility explains the gap', () => {
    const verdict = adjudicate(
      mkBundle({
        signatures: {
          findings: [],
          present: ['reference_held_while_fill_diverged'],
          unevaluated: [],
          score: 0.4,
          // 15% realised volatility: twice that is above the 20% shortfall.
          referenceVolatility: 0.15,
          referenceDriftRatio: 0.01,
          sampledAt: [],
        },
      }),
    );
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('deviation_below_threshold');
  });

  it('stamps a version so behaviour changes are visible in the audit trail', () => {
    expect(ADJUDICATOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
