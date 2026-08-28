import { describe, expect, it } from 'vitest';
import { MINT_REGISTRY, lookupMint, registerCoveredMint } from '@covantic/shared';

/**
 * The covered mint has to be priceable, or nothing downstream works.
 *
 * This is not a hypothetical. The devnet deployment mints its own mock USDC,
 * that address was in `USDC_MINT` but not in `MINT_REGISTRY`, and the
 * consequence was total: `lookupMint` returned null, the loss came back
 * unpriced, and every exploit and agent-error claim resolved
 * `position_not_valued` — permanently, since a retry re-reads the same
 * registry. The whole detection stack looked broken because one mint was
 * unregistered.
 */
describe('covered mint registration', () => {
  const MOCK = '79yZ9PuqbzzdCp2TriBwL9oxPtdfkhuFAjkSR95oJt1B';

  it('prices a mint the shared registry has never heard of', () => {
    expect(MINT_REGISTRY[MOCK], 'precondition: not a registry mint').toBeUndefined();

    registerCoveredMint(MOCK);

    const meta = lookupMint(MOCK);
    expect(meta).not.toBeNull();
    expect(meta?.kind).toBe('stable');
    expect(meta?.decimals).toBe(6);
    expect(meta?.feedKey).toBe('USDC/USD');
  });

  it('leaves a real registry entry alone', () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const before = lookupMint(usdc);

    registerCoveredMint(usdc);

    // Shadowing a mint the registry describes properly would replace a
    // checked entry with a guess.
    expect(lookupMint(usdc)).toEqual(before);
    expect(lookupMint(usdc)?.symbol).toBe('USDC');
  });

  it('treats an unset covered mint as a configuration, not a default', () => {
    registerCoveredMint(undefined);
    expect(lookupMint('NotAMintAddress1111111111111111111111111111')).toBeNull();
  });
});
