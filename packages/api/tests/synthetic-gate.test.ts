import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/env.js';
import { MAINNET_USDC_MINT, syntheticAllowed } from '../src/services/synthetic-gate.js';

/**
 * The synthetic path pays 80% of coverage at confidence 1.0 without reading
 * anything on chain. Three independent conditions must all say "not real
 * money" before it may run, so that a single misconfigured variable is never
 * enough on its own.
 *
 * This lives in its own file because the gate is shared: the claim-keeper
 * asks it before running the synthetic verifier, and
 * `/api/demo/simulate-exploit` asks it before injecting the monitoring event
 * and signed alert that reach the keeper. That route used to gate on
 * NODE_ENV alone, which left the barrier one variable thick at the only
 * unauthenticated entry point into the pipeline.
 */
const safe = {
  NODE_ENV: 'development',
  SOLANA_NETWORK: 'devnet',
  USDC_MINT: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
} as unknown as AppConfig;

const withField = (field: keyof AppConfig, value: unknown) =>
  ({ ...safe, [field]: value }) as unknown as AppConfig;

describe('syntheticAllowed', () => {
  it('permits the synthetic path only when nothing says real money', () => {
    expect(syntheticAllowed(safe)).toBe(true);
  });

  it.each([
    ['NODE_ENV', 'production'],
    ['SOLANA_NETWORK', 'mainnet-beta'],
    ['USDC_MINT', MAINNET_USDC_MINT],
  ] as const)('refuses when %s alone says real money', (field, value) => {
    // Each condition must be independently sufficient to close the gate.
    // If any one of these stops failing, the barrier has thinned.
    expect(syntheticAllowed(withField(field as keyof AppConfig, value))).toBe(false);
  });

  it('refuses a mainnet mint even when NODE_ENV claims development', () => {
    // The specific misconfiguration the third condition exists for: real USDC
    // reachable from a deployment whose NODE_ENV was never switched over.
    expect(syntheticAllowed(withField('USDC_MINT', MAINNET_USDC_MINT))).toBe(false);
  });
});
