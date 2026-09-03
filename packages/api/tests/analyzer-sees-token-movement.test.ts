import { describe, expect, it } from 'vitest';
import { SolanaRpcAnalyzer } from '../src/utils/solana-rpc-analyzer.js';

/**
 * INV-ANALYZE-01 — the analyzer sees token movement, not only SOL.
 *
 * `extractAccountData` returned `tokenBalanceChanges: []` for every account,
 * unconditionally, so the shape it produced described lamports and nothing
 * else. Nothing failed: the field existed, it was an array, and every consumer
 * read it as "this transaction moved no tokens".
 *
 * It became load-bearing when the envelope started being derived. The quote
 * draws the cap from `agent_outflow_events`, that table is filled from these
 * changes, and an agent that had moved USDC every day was underwritten as one
 * that had never spent anything — which puts its cap at its own balance, a
 * limit nothing can cross, and agent-error cover that can never fire.
 */

const OWNER = 'Agent111111111111111111111111111111111111111';
const MINT = 'Usdc1111111111111111111111111111111111111111';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extract = (meta: any, keys: string[]) =>
  (
    SolanaRpcAnalyzer.prototype as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractAccountData: (m: any, meta: any) => any[];
    }
  ).extractAccountData.call(
    null,
    { accountKeys: keys.map((pubkey) => ({ pubkey })) },
    meta,
  );

const balance = (accountIndex: number, amount: string, decimals = 6) => ({
  accountIndex,
  mint: MINT,
  owner: OWNER,
  uiTokenAmount: { amount, decimals },
});

const meta = (pre: unknown[], post: unknown[]) => ({
  preBalances: [0, 0],
  postBalances: [0, 0],
  preTokenBalances: pre,
  postTokenBalances: post,
});

describe('INV-ANALYZE-01 — token balance changes reach the caller', () => {
  it('reports a debit', () => {
    const out = extract(meta([balance(1, '100000000')], [balance(1, '80000000')]), ['a', 'b']);

    expect(out[1].tokenBalanceChanges).toHaveLength(1);
    expect(out[1].tokenBalanceChanges[0].rawTokenAmount.tokenAmount).toBe('-20000000');
    expect(out[1].tokenBalanceChanges[0].userAccount).toBe(OWNER);
    expect(out[1].tokenBalanceChanges[0].mint).toBe(MINT);
  });

  it('reports a credit', () => {
    const out = extract(meta([balance(1, '80000000')], [balance(1, '100000000')]), ['a', 'b']);

    expect(out[1].tokenBalanceChanges[0].rawTokenAmount.tokenAmount).toBe('20000000');
  });

  it('reports an account that had no prior balance', () => {
    const out = extract(meta([], [balance(1, '50000000')]), ['a', 'b']);

    expect(out[1].tokenBalanceChanges[0].rawTokenAmount.tokenAmount).toBe('50000000');
  });

  it('reports an account emptied and closed in the same transaction', () => {
    // Pre balance, no post balance. Dropping this hides the largest movement
    // there is — the one that took everything.
    const out = extract(meta([balance(1, '100000000')], []), ['a', 'b']);

    expect(out[1].tokenBalanceChanges).toHaveLength(1);
    expect(out[1].tokenBalanceChanges[0].rawTokenAmount.tokenAmount).toBe('-100000000');
  });

  it('says nothing about an account whose balance did not move', () => {
    const out = extract(meta([balance(1, '100000000')], [balance(1, '100000000')]), ['a', 'b']);

    expect(out[1].tokenBalanceChanges).toEqual([]);
  });

  it('attaches the change to the account index it belongs to', () => {
    const out = extract(meta([balance(1, '100000000')], [balance(1, '90000000')]), ['a', 'b', 'c']);

    expect(out[0].tokenBalanceChanges).toEqual([]);
    expect(out[1].tokenBalanceChanges).toHaveLength(1);
    expect(out[2].tokenBalanceChanges).toEqual([]);
  });

  it('carries the decimals through, since a raw amount is meaningless without them', () => {
    const out = extract(meta([balance(1, '3000000000', 9)], [balance(1, '1000000000', 9)]), ['a', 'b']);

    expect(out[1].tokenBalanceChanges[0].rawTokenAmount.decimals).toBe(9);
  });

  it('still reports native movement, which is what it always did', () => {
    const out = extract(
      { preBalances: [10, 5], postBalances: [7, 5], preTokenBalances: [], postTokenBalances: [] },
      ['a', 'b'],
    );

    expect(out[0].nativeBalanceChange).toBe(-3);
  });
});
