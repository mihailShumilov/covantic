import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_SOL_PSEUDO_MINT, WRAPPED_SOL_MINT } from '@covantic/shared';
import {
  derivePriceTerms,
  emptyPriceTerms,
  isEmptyPriceTerms,
  priceTermsToInstructionArg,
} from '../src/services/price-terms.js';
import { FEED_IDS } from '../src/services/oracle/price-sources/pyth-hermes.js';
import { CAP_HEADROOM_MULTIPLE } from '../src/services/envelope-derivation.js';

/**
 * The price terms are what stop a compromised oracle key from settling an
 * oracle-manipulation claim against any feed that happened to move. They are
 * derived from the agent's own record, never chosen, so the derivation has to
 * be deterministic and has to refuse to invent a habit the agent does not
 * have.
 */

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('derivePriceTerms', () => {
  it('attests nothing for an agent with no priced habit', () => {
    const terms = derivePriceTerms([]);
    expect(isEmptyPriceTerms(terms)).toBe(true);
    expect(terms).toEqual(emptyPriceTerms());
  });

  it('ignores stablecoin movements — they are the covered mint, not a subject', () => {
    const terms = derivePriceTerms([
      { mint: USDC, amountRaw: 5_000_000, decimals: 6 },
      { mint: USDC, amountRaw: 9_000_000, decimals: 6 },
    ]);
    expect(isEmptyPriceTerms(terms)).toBe(true);
  });

  it('picks the priced asset the agent moves most often and bounds it with headroom', () => {
    const terms = derivePriceTerms([
      { mint: WRAPPED_SOL_MINT, amountRaw: 1_000_000_000, decimals: 9 },
      { mint: WRAPPED_SOL_MINT, amountRaw: 3_000_000_000, decimals: 9 },
      { mint: USDC, amountRaw: 100, decimals: 6 },
    ]);
    expect(Buffer.from(terms.feedId).toString('hex')).toBe(FEED_IDS['SOL/USD']);
    expect(terms.subjectMint.toBase58()).toBe(WRAPPED_SOL_MINT);
    expect(terms.subjectDecimals).toBe(9);
    expect(terms.maxSubjectQuantity).toBe(BigInt(3_000_000_000 * CAP_HEADROOM_MULTIPLE));
  });

  it('folds native SOL into wrapped SOL, as the registry does', () => {
    const terms = derivePriceTerms([
      { mint: NATIVE_SOL_PSEUDO_MINT, amountRaw: 2_000_000_000, decimals: 9 },
    ]);
    expect(terms.subjectMint.toBase58()).toBe(WRAPPED_SOL_MINT);
  });

  it('takes the registry decimals, not the recorded ones', () => {
    // A mis-recorded decimals would mis-scale the loss bound by orders of
    // magnitude; the registry entry has been checked against chain.
    const terms = derivePriceTerms([
      { mint: WRAPPED_SOL_MINT, amountRaw: 1_000_000_000, decimals: 6 },
    ]);
    expect(terms.subjectDecimals).toBe(9);
  });

  it('ignores a mint the registry cannot price', () => {
    const unknown = PublicKey.unique().toBase58();
    const terms = derivePriceTerms([{ mint: unknown, amountRaw: 1_000, decimals: 6 }]);
    expect(isEmptyPriceTerms(terms)).toBe(true);
  });

  it('serialises into the instruction argument shape', () => {
    const terms = derivePriceTerms([
      { mint: WRAPPED_SOL_MINT, amountRaw: 1_000_000_000, decimals: 9 },
    ]);
    const arg = priceTermsToInstructionArg(terms);
    expect(arg.feedId).toHaveLength(32);
    expect(arg.subjectMint.equals(terms.subjectMint)).toBe(true);
    expect(arg.maxSubjectQuantity).toBe(terms.maxSubjectQuantity);
  });
});
