import { BUNDLE_VERSION } from '../../agent/src/predicate/evidence.js';
import type { EvidenceBundle } from '../../agent/src/predicate/baseline.js';
import type { PolicySnapshot } from '../../agent/src/predicate/types.js';

export const AGENT = 'AgentWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const SOL_FEED_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
export const BLOCK_TIME = 1_700_000_000;
const COVERAGE_RAW = 1_000 * 10 ** 6;

function pythPoint(value: number) {
  return {
    value,
    conf: 0.05,
    publishTime: BLOCK_TIME,
    slot: 123,
    source: 'pyth' as const,
    feedId: SOL_FEED_HEX,
    raw: 'ab01',
  };
}

function leg(mint: string, symbol: string, amountUi: number, priceUsd: number, feedKey: string) {
  return {
    mint,
    symbol,
    amountUi,
    priceUsd,
    confPerUnitUsd: 0.0005,
    valueUsd: amountUi * priceUsd,
    confUsd: amountUi * 0.0005,
    feedKey,
    source: 'consensus' as const,
    parFallback: false,
    sourceCount: 4,
    dispersion: 0.001,
  };
}

/**
 * Same shape as the baseline's test bundle: sold 1 SOL worth 200 for 160 USDC.
 * The proof prices the larger leg, so the volatile asset has to be the one sold.
 */
export function mkBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const anchor = { ...pythPoint(200), source: 'consensus' as const, feedId: 'SOL/USD' };
  return {
    version: BUNDLE_VERSION,
    stage: 'verify',
    triggerType: 2,
    txSignature: 'SigAdjudicate',
    agentAddress: AGENT,
    coverageRaw: COVERAGE_RAW,
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
      sold: [{ mint: WRAPPED_SOL, amountUi: 1, decimals: 9 }],
      bought: [{ mint: USDC_MINT, amountUi: 160, decimals: 6 }],
      feeLamports: 5_000,
      droppedSolDustLamports: 0,
    },
    valuation: {
      sold: [leg(WRAPPED_SOL, 'wSOL', 1, 200, 'SOL/USD')],
      bought: [leg(USDC_MINT, 'USDC-dev', 160, 1, 'USDC/USD')],
    },
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
  } as EvidenceBundle;
}

export function mkPolicy(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    address: 'PolicyAddress',
    policyId: '7',
    holder: 'HolderAddress',
    agent: AGENT,
    coverageRaw: COVERAGE_RAW,
    state: 0,
    startTime: BLOCK_TIME - 3_600,
    expiryTime: BLOCK_TIME + 3_600,
    terms: {
      feedIdHex: SOL_FEED_HEX,
      subjectMint: WRAPPED_SOL,
      subjectDecimals: 9,
      maxSubjectQuantity: 10_000_000_000n,
    },
    ...overrides,
  };
}
