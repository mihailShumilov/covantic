import { describe, expect, it, vi } from 'vitest';
import { screenForOracleDeviation } from '../src/services/oracle/prefilter.js';
import {
  PriceSourceUnavailableError,
  type PriceOracle,
  type PriceWindow,
} from '../src/services/oracle/types.js';
import type { EnhancedTransaction } from '../src/utils/helius.js';

const AGENT = 'AgentWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEX_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const KAMINO_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const UNKNOWN_PROGRAM = 'UnknownProgram1111111111111111111111111111';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MYSTERY_MINT = 'MysteryMint111111111111111111111111111111111';

function mkOracle(prices: Record<string, number>, opts: { down?: boolean } = {}): PriceOracle {
  return {
    async getPriceWindow(feedKey: string, targetTime: number): Promise<PriceWindow | null> {
      if (opts.down) {
        throw new PriceSourceUnavailableError('consensus', 'down', { retryAfterSec: 30 });
      }
      const value = prices[feedKey];
      if (value === undefined) return null;
      const anchor = {
        value,
        conf: 0,
        publishTime: targetTime,
        slot: 1,
        source: 'consensus' as const,
        feedId: feedKey,
        raw: null,
      };
      return {
        feedId: feedKey,
        source: 'consensus',
        targetTime,
        before: anchor,
        after: anchor,
        anchor,
        skewSec: 0,
        contributors: [anchor],
        dispersion: 0,
        sourceCount: 4,
      };
    },
  };
}

function mkDelta(account: string, mint: string, raw: number, decimals: number) {
  return {
    account,
    nativeBalanceChange: 0,
    tokenBalanceChanges: [
      { mint, rawTokenAmount: { tokenAmount: String(raw), decimals }, userAccount: AGENT },
    ],
  };
}

function mkTx(partial: Partial<EnhancedTransaction> = {}): EnhancedTransaction {
  return {
    signature: 'SigScreen',
    timestamp: 1_700_000_000,
    type: 'SWAP',
    source: 'JUPITER',
    fee: 5_000,
    feePayer: AGENT,
    transactionError: null,
    instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
    tokenTransfers: [],
    nativeTransfers: [],
    accountData: [
      mkDelta('ata1', USDC_MINT, -250_000_000, 6),
      mkDelta('ata2', WRAPPED_SOL, 1_000_000_000, 9),
      { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
    ],
    ...partial,
  };
}

describe('oracle deviation screen', () => {
  it('flags a swap filled well off the reference', async () => {
    // 250 USDC for 1 SOL when SOL is 200.
    const result = await screenForOracleDeviation(mkTx(), AGENT, mkOracle({ 'SOL/USD': 200 }));
    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('swap_priced_off_reference');
    expect(result.detail.deviation).toBeCloseTo(0.2, 6);
    expect(result.severity).toBe('critical');
  });

  it('ignores a swap filled at the reference', async () => {
    const result = await screenForOracleDeviation(mkTx(), AGENT, mkOracle({ 'SOL/USD': 250 }));
    expect(result.flagged).toBe(false);
  });

  it('screens far below the verifier bar so borderline fills still get looked at', async () => {
    // 1.5% off: nowhere near the verifier's threshold, but the screen is not
    // the thing deciding — sending it on costs one verification.
    const result = await screenForOracleDeviation(
      mkTx(),
      AGENT,
      mkOracle({ 'SOL/USD': 246.25 }),
    );
    expect(result.flagged).toBe(true);
    expect(result.severity).toBe('warning');
  });

  it('ignores dust trades', async () => {
    const tx = mkTx({
      accountData: [
        mkDelta('ata1', USDC_MINT, -1_000_000, 6), // 1 USDC
        mkDelta('ata2', WRAPPED_SOL, 1_000_000, 9),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await screenForOracleDeviation(tx, AGENT, mkOracle({ 'SOL/USD': 200 }));
    expect(result.flagged).toBe(false);
  });

  it('flags rather than drops a swap it cannot price', async () => {
    // Detection fails open. An unpriceable mint is our coverage gap, and a
    // miss here costs the policyholder the whole claim.
    const tx = mkTx({
      accountData: [
        mkDelta('ata1', USDC_MINT, -250_000_000, 6),
        mkDelta('ata2', MYSTERY_MINT, 1_000_000_000, 9),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await screenForOracleDeviation(tx, AGENT, mkOracle({ 'SOL/USD': 200 }));
    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('unpriceable_swap_by_insured_agent');
  });

  it('flags rather than drops when every price source is down', async () => {
    const result = await screenForOracleDeviation(
      mkTx(),
      AGENT,
      mkOracle({}, { down: true }),
    );
    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('price_source_unavailable_during_screen');
  });

  it('flags a lending interaction even with no swap to price', async () => {
    const tx = mkTx({
      instructions: [{ programId: KAMINO_PROGRAM, accounts: [], data: '' }],
      accountData: [
        mkDelta('ata1', USDC_MINT, 500_000_000, 6),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await screenForOracleDeviation(tx, AGENT, mkOracle({ 'SOL/USD': 200 }));
    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('lending_oracle_exposure');
  });

  it('does not touch the network for transactions that are not swaps', async () => {
    const oracle = mkOracle({ 'SOL/USD': 200 });
    const spy = vi.spyOn(oracle, 'getPriceWindow');
    const tx = mkTx({ instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '' }] });
    const result = await screenForOracleDeviation(tx, AGENT, oracle);
    expect(result.flagged).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores a transfer that is not a two-sided swap', async () => {
    const tx = mkTx({
      accountData: [
        mkDelta('ata1', USDC_MINT, -250_000_000, 6),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await screenForOracleDeviation(tx, AGENT, mkOracle({ 'SOL/USD': 200 }));
    expect(result.flagged).toBe(false);
  });

  it('prices against the block time, not the moment of screening', async () => {
    const oracle = mkOracle({ 'SOL/USD': 200 });
    const spy = vi.spyOn(oracle, 'getPriceWindow');
    await screenForOracleDeviation(mkTx({ timestamp: 1_699_123_456 }), AGENT, oracle);
    expect(spy).toHaveBeenCalledWith('SOL/USD', 1_699_123_456);
  });
});
