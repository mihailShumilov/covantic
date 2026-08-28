import type { AppConfig } from '../config/env.js';

/** Mainnet USDC. Its presence means real money regardless of what NODE_ENV
 *  claims. */
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Whether the synthetic (demo) path may run.
 *
 * The synthetic path pays 80% of coverage at confidence 1.0 without looking
 * at anything on-chain, so the gate around it is the only thing standing
 * between a stray demo alert and a real payout. One environment variable is
 * too thin a barrier for that: a misconfigured NODE_ENV on a mainnet
 * deployment would be enough. The cluster and the USDC mint must also both
 * say "not real money".
 *
 * This lives here rather than in the claim-keeper because the keeper is not
 * the only entry point. `/api/demo/simulate-exploit` injects the monitoring
 * event *and* the signed alert that reach the keeper, so a gate the route did
 * not share left the barrier one variable thick at the point where an
 * unauthenticated caller touches it. Both ends must ask the same question.
 */
export function syntheticAllowed(config: AppConfig): boolean {
  return (
    config.NODE_ENV !== 'production' &&
    config.SOLANA_NETWORK !== 'mainnet-beta' &&
    config.USDC_MINT !== MAINNET_USDC_MINT
  );
}
