import { describe, expect, it, vi } from 'vitest';
import { TriggerType } from '@covantic/shared';
import { verifyClaim } from '../src/services/claim-oracle.js';
import type { EnhancedTransaction, HeliusClient } from '../src/utils/helius.js';
import type { PythClient } from '../src/utils/pyth.js';

/**
 * Unit tests for the per-trigger verifier suite.
 *
 * Each test crafts an `EnhancedTransaction` fixture and asserts the
 * verifier returns a sensible verdict. HeliusClient + PythClient are
 * stubbed so we never hit the network.
 */

const AGENT = 'AgentWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FLASH_LOAN_PROGRAM = 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo'; // Solend
const BRIDGE_PROGRAM = 'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb'; // Wormhole
const DEX_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'; // Jupiter v6
const GOV_PROGRAM = 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw';
const UNKNOWN_PROGRAM = 'UnknownProgram1111111111111111111111111111';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const OTHER_WALLET = 'OtherWalletbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Raw coverage amount in USDC lamports (6 decimals). 1,000 USDC. */
const COVERAGE_RAW = 1_000 * 10 ** 6;

function mkTx(partial: Partial<EnhancedTransaction>): EnhancedTransaction {
  return {
    signature: 'SigTest',
    timestamp: 1_700_000_000,
    type: 'UNKNOWN',
    source: 'SYSTEM_PROGRAM',
    fee: 5_000,
    feePayer: AGENT,
    transactionError: null,
    instructions: [],
    tokenTransfers: [],
    nativeTransfers: [],
    accountData: [],
    ...partial,
  };
}

function mkHelius(tx: EnhancedTransaction | null): HeliusClient {
  const helius = {
    getParsedTransaction: vi.fn(async () => tx),
  } as unknown as HeliusClient;
  return helius;
}

function mkPyth(spotBy: Record<string, number | null>): PythClient {
  return {
    getSpotPrice: vi.fn(async (feed: string) => spotBy[feed] ?? null),
    getPrice: vi.fn(async () => null),
  } as unknown as PythClient;
}

describe('verifyClaim — dispatcher', () => {
  it('returns trigger_tx_not_found when Helius has no record', async () => {
    const result = await verifyClaim(
      TriggerType.AgentError,
      'missing',
      AGENT,
      COVERAGE_RAW,
      mkHelius(null),
      mkPyth({}),
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('trigger_tx_not_found');
  });

  it('tolerates getParsedTransaction throwing', async () => {
    const helius = {
      getParsedTransaction: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as HeliusClient;
    const result = await verifyClaim(
      TriggerType.Exploit,
      'SigX',
      AGENT,
      COVERAGE_RAW,
      helius,
      mkPyth({}),
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('trigger_tx_not_found');
  });
});

describe('AgentError verifier', () => {
  it('rejects a self-transfer (all outflow lands in the agent)', async () => {
    const tx = mkTx({
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: AGENT,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 2_000,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('self_transfer');
  });

  it('rejects a DEX trade even with large outflow', async () => {
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER_WALLET,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 2_000,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
      ],
      accountData: [
        {
          account: 'a',
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              mint: USDC_MINT,
              rawTokenAmount: { tokenAmount: '-2000000000', decimals: 6 },
              userAccount: AGENT,
            },
          ],
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('dex_trade');
  });

  it('approves with high confidence when outflow goes through a flash-loan program', async () => {
    const tx = mkTx({
      instructions: [{ programId: FLASH_LOAN_PROGRAM, accounts: [], data: '' }],
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER_WALLET,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 5_000,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
      ],
      accountData: [
        {
          account: 'a',
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              mint: USDC_MINT,
              rawTokenAmount: { tokenAmount: '-5000000000', decimals: 6 },
              userAccount: AGENT,
            },
          ],
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(true);
    expect(result.details.reason).toBe('large_outflow_flash_loan');
    expect(result.lossAmount).toBe(COVERAGE_RAW); // 5k USDC capped at 1k coverage
    expect(result.confidence).toBeCloseTo(0.85);
  });

  it('approves with medium confidence through a bridge program', async () => {
    const tx = mkTx({
      instructions: [{ programId: BRIDGE_PROGRAM, accounts: [], data: '' }],
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER_WALLET,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 2_000,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
      ],
      accountData: [
        {
          account: 'a',
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              mint: USDC_MINT,
              rawTokenAmount: { tokenAmount: '-2000000000', decimals: 6 },
              userAccount: AGENT,
            },
          ],
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(true);
    expect(result.details.reason).toBe('large_outflow_bridge');
    expect(result.confidence).toBeCloseTo(0.5);
  });

  it('approves fee-level loss on a failed tx', async () => {
    const tx = mkTx({
      transactionError: { InstructionError: [0, 'Custom'] },
      fee: 12_000, // SOL lamports
    });
    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(true);
    expect(result.details.reason).toBe('failed_tx');
    expect(result.lossAmount).toBeGreaterThan(0);
    expect(result.lossAmount).toBeLessThanOrEqual(COVERAGE_RAW);
  });

  it('rejects sub-threshold outflow with no_detected_loss', async () => {
    const tx = mkTx({
      instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '' }],
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER_WALLET,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 10,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
      ],
      accountData: [
        {
          account: 'a',
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              mint: USDC_MINT,
              rawTokenAmount: { tokenAmount: '-10000000', decimals: 6 },
              userAccount: AGENT,
            },
          ],
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('no_detected_loss');
  });
});

describe('Exploit verifier', () => {
  it('approves high-confidence flash-loan exploit', async () => {
    const tx = mkTx({
      instructions: [{ programId: FLASH_LOAN_PROGRAM, accounts: [], data: '' }],
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER_WALLET,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 10_000,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
      ],
      accountData: [
        {
          account: 'a',
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              mint: USDC_MINT,
              rawTokenAmount: { tokenAmount: '-10000000000', decimals: 6 },
              userAccount: AGENT,
            },
          ],
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.Exploit,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(true);
    expect(result.details.reason).toBe('flash_loan_exploit');
    expect(result.confidence).toBeCloseTo(0.9);
    expect(result.lossAmount).toBe(COVERAGE_RAW);
  });

  it('rejects a DEX-only tx as legitimate trading', async () => {
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      accountData: [
        {
          account: 'a',
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              mint: USDC_MINT,
              rawTokenAmount: { tokenAmount: '-2000000000', decimals: 6 },
              userAccount: AGENT,
            },
          ],
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.Exploit,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('dex_only');
  });

  it('rejects when no USDC outflow is observable', async () => {
    const tx = mkTx({
      instructions: [{ programId: FLASH_LOAN_PROGRAM, accounts: [], data: '' }],
    });
    const result = await verifyClaim(
      TriggerType.Exploit,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('no_outflow');
  });
});

describe('OracleManipulation verifier', () => {
  it('approves when tx price deviates >3% from Pyth spot (agent overpays)', async () => {
    // Agent buys 1 SOL for 250 USDC. Pyth spot = 200 USDC/SOL → 25% overpay.
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER_WALLET,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 250,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
        {
          fromUserAccount: OTHER_WALLET,
          toUserAccount: AGENT,
          fromTokenAccount: 'c',
          toTokenAccount: 'd',
          tokenAmount: 1,
          mint: WRAPPED_SOL,
          tokenStandard: 'Fungible',
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({ 'SOL/USD': 200 }),
      { usdcMint: USDC_MINT },
    );
    expect(result.verified).toBe(true);
    expect(result.details.reason).toBe('price_deviation');
    expect(result.details.agentRole).toBe('buyer');
    expect(result.lossAmount).toBe(50 * 10 ** 6); // 50 USDC overpay, under coverage
  });

  it('rejects when deviation is below threshold', async () => {
    // 2% deviation — below our 3% trigger.
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER_WALLET,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 204,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
        {
          fromUserAccount: OTHER_WALLET,
          toUserAccount: AGENT,
          fromTokenAccount: 'c',
          toTokenAccount: 'd',
          tokenAmount: 1,
          mint: WRAPPED_SOL,
          tokenStandard: 'Fungible',
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({ 'SOL/USD': 200 }),
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('deviation_below_threshold');
  });

  it('rejects when tx has no DEX interaction', async () => {
    const tx = mkTx({
      instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '' }],
    });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('no_dex_interaction');
  });

  it('rejects when Pyth has no price for the mint', async () => {
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER_WALLET,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 500,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
        {
          fromUserAccount: OTHER_WALLET,
          toUserAccount: AGENT,
          fromTokenAccount: 'c',
          toTokenAccount: 'd',
          tokenAmount: 100,
          mint: WRAPPED_SOL,
          tokenStandard: 'Fungible',
        },
      ],
    });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({ 'SOL/USD': null }),
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('pyth_unavailable');
  });
});

describe('GovernanceAttack verifier', () => {
  it('approves when a governance program is invoked with balance movement', async () => {
    const tx = mkTx({
      instructions: [{ programId: GOV_PROGRAM, accounts: [], data: '' }],
      accountData: [
        { account: 'a', nativeBalanceChange: 100_000_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await verifyClaim(
      TriggerType.GovernanceAttack,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
    );
    expect(result.verified).toBe(true);
    expect(result.details.reason).toBe('governance_state_change_detected');
    expect(result.lossAmount).toBe(COVERAGE_RAW / 2);
  });

  it('rejects when no governance program was called', async () => {
    const tx = mkTx({
      instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '' }],
    });
    const result = await verifyClaim(
      TriggerType.GovernanceAttack,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('no_governance_program');
  });

  it('rejects when governance program was called but no balance moved', async () => {
    const tx = mkTx({
      instructions: [{ programId: GOV_PROGRAM, accounts: [], data: '' }],
      accountData: [{ account: 'a', nativeBalanceChange: 1_000, tokenBalanceChanges: [] }],
    });
    const result = await verifyClaim(
      TriggerType.GovernanceAttack,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPyth({}),
    );
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('governance_call_no_state_change');
  });
});
