import { describe, expect, it } from 'vitest';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  CAP_HEADROOM_MULTIPLE,
  deriveEnvelope,
  maxInsurableCoverageRaw,
} from '../src/services/envelope-derivation.js';

const usdc = (n: number) => Math.round(n * 1_000_000);

describe('the envelope is derived from the agent, not chosen by the buyer', () => {
  it('sets the cap at a multiple of what this agent ordinarily moves', () => {
    const { envelope, basis, ordinaryOutflowRaw } = deriveEnvelope({
      coveredBalanceRaw: usdc(5_000),
      p95OutflowRaw: usdc(20),
      transferCount: 8,
    });

    expect(envelope.maxSingleOutflowRaw).toBe(usdc(20) * CAP_HEADROOM_MULTIPLE);
    expect(basis).toBe('history');
    expect(ordinaryOutflowRaw).toBe(usdc(20));
  });

  it('does not let the balance move the cap when there is a habit to measure', () => {
    // The whole point of deriving: two agents with the same behaviour get the
    // same envelope, however much they happen to be holding. Under the old
    // form the richer one could be given a tighter cap and a larger claim.
    const poor = deriveEnvelope({
      coveredBalanceRaw: usdc(800),
      p95OutflowRaw: usdc(20),
      transferCount: 8,
    });
    const rich = deriveEnvelope({
      coveredBalanceRaw: usdc(500_000),
      p95OutflowRaw: usdc(20),
      transferCount: 8,
    });

    expect(rich.envelope).toEqual(poor.envelope);
  });

  it('caps an unobserved agent at its own balance, so nothing can cross it', () => {
    // An agent nobody has watched gets a cap it cannot exceed — it cannot move
    // more than it holds. The cover is real on the other three triggers and
    // carries no agent-error exposure at all, which is the honest position for
    // an agent with no history.
    const { envelope, basis, ordinaryOutflowRaw } = deriveEnvelope({
      coveredBalanceRaw: usdc(800),
      p95OutflowRaw: null,
      transferCount: 0,
    });

    expect(envelope.maxSingleOutflowRaw).toBe(usdc(800));
    expect(basis).toBe('balance');
    expect(ordinaryOutflowRaw).toBeNull();
  });

  it('treats a thin history as no history', () => {
    const { basis } = deriveEnvelope({
      coveredBalanceRaw: usdc(800),
      p95OutflowRaw: usdc(20),
      transferCount: 4, // one short of the minimum
    });

    expect(basis).toBe('balance');
  });

  it('never derives a zero cap, which the program refuses', () => {
    // An empty, unobserved agent. `max(1, ...)` is the difference between a
    // policy and a transaction that fails with `InvalidAgentMandate`.
    const { envelope } = deriveEnvelope({
      coveredBalanceRaw: 0,
      p95OutflowRaw: null,
      transferCount: 0,
    });

    expect(envelope.maxSingleOutflowRaw).toBeGreaterThan(0);
  });

  it('declares the token program, because that is a fact rather than a guess', () => {
    // The covered asset is an SPL token, so every movement of it goes through
    // the token program by construction. Declaring it is worth 0.03 of the
    // confidence a payout needs, and costs nothing in truthfulness.
    const { envelope } = deriveEnvelope({
      coveredBalanceRaw: usdc(800),
      p95OutflowRaw: usdc(20),
      transferCount: 8,
    });

    expect(envelope.allowedPrograms).toEqual([TOKEN_PROGRAM_ID.toBase58()]);
  });

  it('leaves the counterparty allowlist empty rather than inventing one', () => {
    // The events table records amounts and times, not destinations. An
    // allowlist that omits a real counterparty turns ordinary business into a
    // breach, which is worse than the 0.03 that silence costs.
    const { envelope } = deriveEnvelope({
      coveredBalanceRaw: usdc(800),
      p95OutflowRaw: usdc(20),
      transferCount: 8,
    });

    expect(envelope.allowedCounterparties).toEqual([]);
  });

  it('leaves the retention floor undeclared, which costs no confidence', () => {
    // `evaluateBreach` reports an absent cap as unevaluated but simply skips an
    // absent floor, so zero here is free — and a derived floor would be this
    // module inventing a deductible out of nothing observable.
    const { envelope } = deriveEnvelope({
      coveredBalanceRaw: usdc(800),
      p95OutflowRaw: usdc(20),
      transferCount: 8,
    });

    expect(envelope.minRetainedBalanceRaw).toBe(0);
  });

  it('keeps the window cap above the single cap, as the program requires', () => {
    const { envelope } = deriveEnvelope({
      coveredBalanceRaw: usdc(800),
      p95OutflowRaw: usdc(20),
      transferCount: 8,
    });

    expect(envelope.maxWindowOutflowRaw).toBeGreaterThanOrEqual(envelope.maxSingleOutflowRaw);
    expect(envelope.windowSeconds).toBeGreaterThan(0);
  });
});

describe('the most cover worth selling', () => {
  it('is what the agent holds, when the vault can carry it', () => {
    const { maxCoverageRaw, bound } = maxInsurableCoverageRaw({
      coveredBalanceRaw: usdc(800),
      totalStakedRaw: usdc(37_000),
      totalCoverageRaw: usdc(16_000),
    });

    expect(maxCoverageRaw).toBe(usdc(800));
    expect(bound).toBe('agent_balance');
  });

  it('is the vault’s remaining capacity when that is tighter', () => {
    // `create_policy` refuses below half of coverage staked, so the vault can
    // carry twice its stake in total. Saying so at the quote is the difference
    // between changing a number and a signed transaction failing with
    // `SolvencyTooLow`.
    const { maxCoverageRaw, bound } = maxInsurableCoverageRaw({
      coveredBalanceRaw: usdc(10_000),
      totalStakedRaw: usdc(9_000),
      totalCoverageRaw: usdc(16_000),
    });

    expect(maxCoverageRaw).toBe(usdc(2_000)); // 2 × 9,000 − 16,000
    expect(bound).toBe('vault_capacity');
  });

  it('never goes negative when the vault is already over-extended', () => {
    const { maxCoverageRaw } = maxInsurableCoverageRaw({
      coveredBalanceRaw: usdc(10_000),
      totalStakedRaw: usdc(5_000),
      totalCoverageRaw: usdc(16_000),
    });

    expect(maxCoverageRaw).toBe(0);
  });
});
