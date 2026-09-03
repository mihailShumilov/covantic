import { describe, expect, it } from 'vitest';
import { outflowsFromBalanceChanges } from '../src/services/agent-error/baseline.js';

/**
 * INV-HISTORY-01 — underwriting an agent writes down what it spends.
 *
 * The envelope is derived from an agent's spending history, and the sweep that
 * records that history only walks agents which already hold an active policy.
 * So an agent nobody has insured has no history, the derived cap falls back to
 * its balance — a cap nothing can cross, since an agent cannot move more than
 * it holds — and the agent-error trigger can never fire on the policy anyone
 * actually buys. Cover that needs a history, and a history that needs cover.
 *
 * The risk assessment breaks it. It is required before a quote, and it already
 * reads a hundred of the agent's transactions in order to score it.
 */

const AGENT = 'AgentAddress11111111111111111111111111111111';
const MINT = 'Usdc1111111111111111111111111111111111111111';

const change = (userAccount: string, mint: string, amount: string, decimals = 6) => ({
  mint,
  userAccount,
  rawTokenAmount: { tokenAmount: amount, decimals },
});

describe('INV-HISTORY-01 — what the assessment observed leaving the agent', () => {
  it('records a debit as an outflow', () => {
    const out = outflowsFromBalanceChanges({
      agentAddress: AGENT,
      signature: 'sig1',
      blockTime: new Date('2026-09-03T00:00:00Z'),
      accountData: [{ tokenBalanceChanges: [change(AGENT, MINT, '-20000000')] }],
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.amountRaw).toBe(20_000_000);
    expect(out[0]!.mint).toBe(MINT);
    expect(out[0]!.decimals).toBe(6);
  });

  it('ignores a credit', () => {
    const out = outflowsFromBalanceChanges({
      agentAddress: AGENT,
      signature: 'sig2',
      blockTime: new Date(),
      accountData: [{ tokenBalanceChanges: [change(AGENT, MINT, '50000000')] }],
    });

    expect(out).toEqual([]);
  });

  it('ignores movements of somebody else’s account in the same transaction', () => {
    const out = outflowsFromBalanceChanges({
      agentAddress: AGENT,
      signature: 'sig3',
      blockTime: new Date(),
      accountData: [
        { tokenBalanceChanges: [change('SomeoneElse1111111111111111111111111111111', MINT, '-90000000')] },
      ],
    });

    expect(out).toEqual([]);
  });

  it('nets a transaction that both credits and debits the agent', () => {
    // The reason this reads balance changes rather than a transfer list. A
    // swap routed through the agent's own account shows a large transfer out
    // and a large one back; what the caps are measured against is what the
    // account is left short by, which is the difference.
    const out = outflowsFromBalanceChanges({
      agentAddress: AGENT,
      signature: 'sig4',
      blockTime: new Date(),
      accountData: [
        { tokenBalanceChanges: [change(AGENT, MINT, '-100000000')] },
        { tokenBalanceChanges: [change(AGENT, MINT, '95000000')] },
      ],
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.amountRaw).toBe(5_000_000);
  });

  it('reports nothing when the net movement is inward', () => {
    const out = outflowsFromBalanceChanges({
      agentAddress: AGENT,
      signature: 'sig5',
      blockTime: new Date(),
      accountData: [
        { tokenBalanceChanges: [change(AGENT, MINT, '-10000000')] },
        { tokenBalanceChanges: [change(AGENT, MINT, '40000000')] },
      ],
    });

    expect(out).toEqual([]);
  });

  it('keeps mints apart', () => {
    const other = 'Other111111111111111111111111111111111111111';
    const out = outflowsFromBalanceChanges({
      agentAddress: AGENT,
      signature: 'sig6',
      blockTime: new Date(),
      accountData: [
        { tokenBalanceChanges: [change(AGENT, MINT, '-20000000'), change(AGENT, other, '-3000000000', 9)] },
      ],
    });

    expect(out).toHaveLength(2);
    expect(out.find((o) => o.mint === other)?.decimals).toBe(9);
  });

  it('survives a transaction carrying no balance changes at all', () => {
    const out = outflowsFromBalanceChanges({
      agentAddress: AGENT,
      signature: 'sig7',
      blockTime: new Date(),
      accountData: [],
    });

    expect(out).toEqual([]);
  });
});
