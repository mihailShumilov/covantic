import { describe, expect, it, vi } from 'vitest';
import { TriggerType } from '@covantic/shared';
import { verifyClaim } from '../src/services/claim-oracle.js';
import type { EnhancedTransaction, HeliusClient } from '../src/utils/helius.js';
import {
  PriceSourceUnavailableError,
  type PriceOracle,
  type PricePoint,
  type PriceSourceId,
  type PriceWindow,
} from '../src/services/oracle/types.js';

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
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const KAMINO_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
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

/** Knobs for the stubbed reference. A bare number is the common case:
 *  "the sources agreed this feed was worth X at the block time". */
interface MockFeed {
  price: number | null;
  /** Confidence interval in price units, as the sources reported it. */
  conf?: number;
  /** Seconds between the sample and the requested block time. */
  skewSec?: number;
  /** Simulate every source being down rather than having no data. */
  unavailable?: boolean;
  /** Only one side of the bracketing window exists (single-source only). */
  oneSided?: boolean;
  /** Signed proof blob; null models a source that cannot prove itself. */
  raw?: string | null;
  /** How many independent sources corroborated. Default 4 (Pyth + three
   *  exchanges), which is what production wires up. */
  sources?: number;
  /** Relative spread between those sources. */
  dispersion?: number;
  /** Anchor for `driftPerSec`; samples are offset from this instant. */
  baseTime?: number;
  /** Fractional price change per second away from `baseTime`. Models a real
   *  market move, which every reference follows. */
  driftPerSec?: number;
  /** Hex Pyth feed id to stamp on the pyth contributor, so proof-building can
   *  find its signed update. */
  pythFeedId?: string;
}

type MockFeeds = Record<string, number | null | MockFeed>;

const MOCK_SOURCE_IDS: PriceSourceId[] = ['pyth', 'binance', 'coinbase', 'kraken'];

/**
 * Stub price oracle.
 *
 * Returns consensus-shaped windows by default because that is what the
 * production pipeline supplies; a single-source window is a distinct case the
 * verifier deliberately refuses to confirm on, and tests that want it ask for
 * it with `sources: 1`.
 */
function mkPricer(feeds: MockFeeds): PriceOracle {
  const normalise = (v: number | null | MockFeed | undefined): MockFeed | undefined =>
    v === undefined ? undefined : typeof v === 'number' || v === null ? { price: v } : v;

  const getPriceWindow = vi.fn(
    async (feedKey: string, targetTime: number): Promise<PriceWindow | null> => {
      const feed = normalise(feeds[feedKey]);
      if (!feed) return null;
      // `drift` moves the reference away from its block-time value as the
      // sampler steps either side of the transaction, which is how a real
      // market move is distinguished from a venue-local dislocation.
      const offset = targetTime - (feed.baseTime ?? targetTime);
      if (feed.unavailable) {
        throw new PriceSourceUnavailableError('consensus', 'mock sources down', {
          retryAfterSec: 42,
          status: 429,
        });
      }
      if (feed.price === null) return null;

      const skewSec = feed.skewSec ?? 0;
      const sourceCount = feed.sources ?? 4;
      const dispersion = feed.dispersion ?? 0;
      const mk = (source: PriceSourceId, value: number): PricePoint => ({
        value,
        conf: feed.conf ?? 0,
        publishTime: targetTime - skewSec,
        slot: 123_456,
        source,
        feedId: feedKey,
        raw: feed.raw === undefined ? 'ab01' : feed.raw,
      });

      const drifted = feed.price! * (1 + (feed.driftPerSec ?? 0) * offset);
      const contributors = MOCK_SOURCE_IDS.slice(0, sourceCount).map((id, i) => {
        const point = mk(id, drifted * (1 + (i === 0 ? 0 : dispersion)));
        // Only Pyth carries a guardian-signed payload; the exchanges are
        // plain REST and have nothing the chain can verify.
        if (id === 'pyth' && feed.pythFeedId) return { ...point, feedId: feed.pythFeedId };
        if (id !== 'pyth') return { ...point, raw: null };
        return point;
      });
      const anchor = mk('consensus', drifted);

      return {
        feedId: feedKey,
        source: 'consensus',
        targetTime,
        before: feed.oneSided ? null : anchor,
        after: anchor,
        anchor,
        skewSec: Math.abs(skewSec),
        contributors,
        dispersion,
        sourceCount,
        missing: [],
      };
    },
  );

  return { getPriceWindow } as unknown as PriceOracle;
}

/** One `accountData` entry carrying a token balance delta for the agent. */
function mkTokenDelta(account: string, mint: string, rawDelta: number, decimals: number) {
  return {
    account,
    nativeBalanceChange: 0,
    tokenBalanceChanges: [
      {
        mint,
        rawTokenAmount: { tokenAmount: String(rawDelta), decimals },
        userAccount: AGENT,
      },
    ],
  };
}

/**
 * A DEX swap where the agent pays `usdc` and receives `boughtUi` of
 * `boughtMint`.
 *
 * Carries both `tokenTransfers` and the `accountData` balance deltas a real
 * Helius payload has. The verifier reads the deltas — they are the chain's
 * own pre/post diff and survive multi-hop routing, which transfer legs do
 * not — so a fixture without them is not a swap at all.
 */
function mkSwapTx(
  usdc: number,
  boughtUi: number,
  partial: Partial<EnhancedTransaction> = {},
  boughtMint: string = WRAPPED_SOL,
  boughtDecimals = 9,
) {
  const fee = 5_000;
  return mkTx({
    instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
    fee,
    tokenTransfers: [
      {
        fromUserAccount: AGENT,
        toUserAccount: OTHER_WALLET,
        fromTokenAccount: 'a',
        toTokenAccount: 'b',
        tokenAmount: usdc,
        mint: USDC_MINT,
        tokenStandard: 'Fungible',
      },
      {
        fromUserAccount: OTHER_WALLET,
        toUserAccount: AGENT,
        fromTokenAccount: 'c',
        toTokenAccount: 'd',
        tokenAmount: boughtUi,
        mint: boughtMint,
        tokenStandard: 'Fungible',
      },
    ],
    accountData: [
      mkTokenDelta('agent-usdc-ata', USDC_MINT, -Math.round(usdc * 1e6), 6),
      mkTokenDelta(
        'agent-bought-ata',
        boughtMint,
        Math.round(boughtUi * 10 ** boughtDecimals),
        boughtDecimals,
      ),
      // The agent paid the fee and nothing else moved natively.
      { account: AGENT, nativeBalanceChange: -fee, tokenBalanceChanges: [] },
    ],
    ...partial,
  });
}

describe('verifyClaim — dispatcher', () => {
  it('returns trigger_tx_not_found when Helius has no record', async () => {
    const result = await verifyClaim(
      TriggerType.AgentError,
      'missing',
      AGENT,
      COVERAGE_RAW,
      mkHelius(null),
      mkPricer({}),
    );
    expect(result.verified).toBe(false);
    // Not a rejection: an unindexed signature says nothing about the loss.
    expect(result.outcome).toBe('indeterminate');
    expect(result.retryAfterSec).toBeGreaterThan(0);
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
      mkPricer({}),
    );
    expect(result.verified).toBe(false);
    // Not a rejection: an unindexed signature says nothing about the loss.
    expect(result.outcome).toBe('indeterminate');
    expect(result.retryAfterSec).toBeGreaterThan(0);
    expect(result.details.reason).toBe('trigger_tx_not_found');
  });
});

describe('AgentError verifier', () => {
  /**
   * Every case here used to assert the opposite, and the inversion is the
   * point of the change.
   *
   * The old verifier decided on which programs appeared in a transaction: a
   * DEX rejected outright as "legitimate trading", a flash-loan program
   * confirmed at 0.85, a bridge at 0.5, anything unrecognised at 0.6 — and a
   * reverted transaction confirmed at 0.6 on a flat, invented 1 USDC. So it
   * paid for bridge transfers to the holder's own address and denied a
   * catastrophic misrouted swap through Jupiter.
   *
   * The behavioural cases now live in `agent-error-corpus.test.ts`, which can
   * supply the chain record and a declared mandate. What is left here is the
   * dispatcher's contract: without those inputs the verifier must escalate,
   * never decide.
   */

  it('escalates instead of deciding when the chain record is unavailable', async () => {
    // No RPC connection, so nothing can say whether the *agent's own*
    // authority moved the money — the fact that separates this trigger from
    // an exploit. "We could not check" must never be recorded as a verdict.
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
    });

    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({}),
      { usdcMint: USDC_MINT },
    );

    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('no_chain_record');
    expect(result.lossAmount).toBe(0);
  });

  it('no longer confirms on program membership alone', async () => {
    // The exact transaction the old verifier paid 0.85-confidence coverage
    // for: a flash-loan program and a large outflow. Nothing here says the
    // movement fell outside anything the holder declared, so there is nothing
    // to pay.
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
    });

    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({}),
      { usdcMint: USDC_MINT },
    );

    expect(result.verified).toBe(false);
    expect(result.lossAmount).toBe(0);
  });

  it('attaches a replayable evidence bundle to every verdict', async () => {
    // This trigger produced no bundle at all before, so `recordEvidence`
    // returned early on every claim and an agent-error payout was not
    // reproducible even in principle.
    const tx = mkTx({ tokenTransfers: [] });

    const result = await verifyClaim(
      TriggerType.AgentError,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({}),
      { usdcMint: USDC_MINT },
    );

    expect(result.evidence).toBeDefined();
    expect(result.evidence).toMatchObject({ triggerType: TriggerType.AgentError });
  });
});

describe('Exploit verifier', () => {
  /**
   * The three cases here used to assert the opposite of what they assert now,
   * and that inversion is the point of the change.
   *
   * The old verifier decided on which programs appeared in a transaction:
   * a flash-loan program plus an outflow confirmed at 0.9 and paid the full
   * coverage; a known DEX rejected outright as "legitimate trading"; no
   * *USDC* outflow rejected as "no loss". None of it asked who authorised the
   * movement, so it paid for ordinary leveraged trading and denied every
   * drain routed through Jupiter.
   */

  it('no longer confirms on program membership alone', async () => {
    // Identical to the transaction the old verifier paid full coverage for:
    // a flash-loan program and 10,000 USDC out. Nothing here says the agent
    // did not authorise it, so there is nothing to pay.
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
      mkPricer({}),
      { usdcMint: USDC_MINT },
    );

    expect(result.verified).toBe(false);
    expect(result.lossAmount).toBe(0);
  });

  it('escalates instead of denying when the chain record is unavailable', async () => {
    // No RPC connection, so authorization cannot be read. "We could not
    // check" must never be recorded as "there was no loss" — that collapse is
    // how a valid claim gets destroyed by an infrastructure problem.
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
      mkPricer({}),
      { usdcMint: USDC_MINT },
    );

    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('no_chain_record');
    // Retryable, and it carries what evidence there was for a reviewer.
    expect(result.retryAfterSec).toBeGreaterThan(0);
    expect(result.evidence).toBeDefined();
  });

  it('attaches a replayable evidence bundle to every verdict', async () => {
    const tx = mkTx({ instructions: [{ programId: FLASH_LOAN_PROGRAM, accounts: [], data: '' }] });

    const result = await verifyClaim(
      TriggerType.Exploit,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({}),
      { usdcMint: USDC_MINT },
    );

    const bundle = result.evidence as unknown as Record<string, unknown>;
    expect(bundle.triggerType).toBe(TriggerType.Exploit);
    expect(bundle.txSignature).toBe(tx.signature);
    // The old verifier returned a bag of scalars and nothing was persisted,
    // so no exploit verdict could ever be re-derived.
    expect(bundle.position).toBeDefined();
    expect(bundle.hasRawTx).toBe(false);
  });
});

describe('OracleManipulation verifier', () => {
  it('approves when the fill deviates from the reference at block time', async () => {
    // Agent buys 1 SOL for 250 USDC while the reference says 200.
    const tx = mkSwapTx(250, 1);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
      { usdcMint: USDC_MINT },
    );

    expect(result.outcome).toBe('confirmed');
    expect(result.details.reason).toBe('price_deviation');
    expect(result.details.agentRole).toBe('buyer');
    // 50 USDC overpaid, less the 30bps the trade would have cost anyway
    // (0.75 USDC). The vault does not reimburse ordinary market friction.
    expect(result.lossAmount).toBe(49_250_000);
  });

  it('subtracts the honest cost of trading before calling anything a loss', async () => {
    const tx = mkSwapTx(250, 1);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );
    expect(result.details.shortfallUsd).toBeCloseTo(50, 6);
    expect(result.details.expectedCostUsd).toBeCloseTo(0.75, 6);
    expect(result.details.excessLossUsd).toBeCloseTo(49.25, 6);
  });

  it('rejects when deviation is below threshold', async () => {
    // 2% deviation — below the 3% bar.
    const tx = mkSwapTx(204, 1);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.details.reason).toBe('deviation_below_threshold');
  });

  it('leaves nothing payable when the gap is smaller than the trading fee', async () => {
    // A 0.25% gap on a 30bps venue is not a loss — the agent would have paid
    // more than that to trade honestly.
    const tx = mkSwapTx(200.5, 1);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.details.reason).toBe('deviation_below_threshold');
    expect(result.details.excessLossUsd as number).toBeLessThanOrEqual(0);
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
      mkPricer({}),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.details.reason).toBe('no_dex_interaction');
  });

  it('routes to indeterminate when the reference has no price at block time', async () => {
    const tx = mkSwapTx(500, 100);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': null }),
    );
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('no_price_at_block_time');
  });
});

describe('OracleManipulation verifier — execution reconstruction (Phase 2)', () => {
  it('nets a multi-hop route into a single position change', async () => {
    // Jupiter routes USDC -> wSOL -> USDC -> wSOL across four transfer legs.
    // Reading the two largest transfers would price an intermediate hop; the
    // netted balance delta is still just "paid 250 USDC, received 1 SOL".
    const tx = mkSwapTx(250, 1);
    tx.tokenTransfers = [
      ...tx.tokenTransfers,
      {
        fromUserAccount: AGENT,
        toUserAccount: OTHER_WALLET,
        fromTokenAccount: 'e',
        toTokenAccount: 'f',
        tokenAmount: 9_999,
        mint: WRAPPED_SOL,
        tokenStandard: 'Fungible',
      },
      {
        fromUserAccount: OTHER_WALLET,
        toUserAccount: AGENT,
        fromTokenAccount: 'g',
        toTokenAccount: 'h',
        tokenAmount: 9_999,
        mint: WRAPPED_SOL,
        tokenStandard: 'Fungible',
      },
    ];

    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );

    expect(result.outcome).toBe('confirmed');
    expect(result.lossAmount).toBe(49_250_000);
  });

  it('treats a wrap/unwrap round trip as no position change', async () => {
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      accountData: [
        mkTokenDelta('agent-wsol-ata', WRAPPED_SOL, 1_000_000_000, 9),
        { account: AGENT, nativeBalanceChange: -1_000_005_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );
    // Wrapped SOL is folded onto native SOL, so wrapping is not a trade.
    expect(result.outcome).toBe('rejected');
    expect(result.details.reason).toBe('no_position_change');
  });

  it('does not score the network fee as an execution shortfall', async () => {
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      fee: 5_000,
      accountData: [{ account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] }],
    });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );
    expect(result.details.reason).toBe('no_position_change');
  });

  it('sends a many-to-many swap to review rather than guessing a price', async () => {
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      accountData: [
        mkTokenDelta('a1', USDC_MINT, -250_000_000, 6),
        mkTokenDelta('a2', USDT_MINT, -100_000_000, 6),
        mkTokenDelta('a3', WRAPPED_SOL, 1_000_000_000, 9),
        mkTokenDelta('a4', JITOSOL_MINT, 500_000_000, 9),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('unsupported_swap_shape');
  });

  it('prices a non-USDC pair by valuing both sides', async () => {
    // wSOL sold for JitoSOL. The old verifier required a USDC leg and could
    // not look at this at all; both mints have feeds, so it is priceable.
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      fee: 5_000,
      accountData: [
        mkTokenDelta('a1', WRAPPED_SOL, -10_000_000_000, 9), // -10 SOL @ 200 = 2000
        mkTokenDelta('a2', JITOSOL_MINT, 6_000_000_000, 9), // +6 JitoSOL @ 250 = 1500
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200, 'JITOSOL/USD': 250 }),
    );

    expect(result.outcome).toBe('confirmed');
    expect(result.details.shortfallUsd).toBeCloseTo(500, 6);
    // 30bps of 2000 = 6 USD of honest cost.
    expect(result.lossAmount).toBe(494_000_000);
  });

  it('values a liquid staking token off its own feed, not SOL', async () => {
    // JitoSOL trades above SOL by accrued yield. Pricing it off SOL/USD would
    // read that premium as a permanent shortfall on every LST trade.
    const tx = mkTx({
      instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
      fee: 5_000,
      accountData: [
        mkTokenDelta('a1', USDC_MINT, -250_000_000, 6),
        mkTokenDelta('a2', JITOSOL_MINT, 1_000_000_000, 9),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    });
    const pricer = mkPricer({ 'SOL/USD': 200, 'JITOSOL/USD': 250 });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      pricer,
    );

    expect(pricer.getPriceWindow).toHaveBeenCalledWith(
      'JITOSOL/USD',
      expect.any(Number),
      expect.any(Number),
    );
    // 250 paid for 250 of value: no shortfall once the right feed is used.
    expect(result.outcome).toBe('rejected');
  });
});

describe('OracleManipulation verifier — source consensus (Phase 3)', () => {
  const swap = () => mkSwapTx(250, 1);

  async function judge(feeds: Parameters<typeof mkPricer>[0]) {
    const tx = swap();
    return verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer(feeds),
    );
  }

  it('refuses to confirm on a single source, however large the deviation', async () => {
    // This is the core of the phase. A lone feed cannot establish that a
    // feed was manipulated, because the lone feed may be the manipulated one.
    const result = await judge({ 'SOL/USD': { price: 200, sources: 1 } });
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('insufficient_price_sources');
    expect(result.details.sourceCount).toBe(1);
    expect(result.details.required).toBe(3);
  });

  it('refuses to confirm on two sources — a disagreement would be unattributable', async () => {
    const result = await judge({ 'SOL/USD': { price: 200, sources: 2 } });
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('insufficient_price_sources');
  });

  it('confirms once three independent sources agree', async () => {
    const result = await judge({ 'SOL/USD': { price: 200, sources: 3 } });
    expect(result.outcome).toBe('confirmed');
  });

  it('goes to review when the references contradict each other', async () => {
    // One source dragged 8% away from the others. That is what a manipulated
    // feed looks like from outside — and it means we cannot say what the fair
    // price was, only that somebody is wrong.
    const result = await judge({ 'SOL/USD': { price: 200, dispersion: 0.08 } });
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('price_sources_disagree');
    expect(result.details.dispersion).toBeCloseTo(0.08, 6);
  });

  it('survives one source drifting inside the tolerance band', async () => {
    const result = await judge({ 'SOL/USD': { price: 200, dispersion: 0.01 } });
    expect(result.outcome).toBe('confirmed');
  });

  it('is more confident with four corroborating sources than with three', async () => {
    const three = await judge({ 'SOL/USD': { price: 200, sources: 3 } });
    const four = await judge({ 'SOL/USD': { price: 200, sources: 4 } });
    expect(four.confidence).toBeGreaterThan(three.confidence);
  });

  it('is less confident as the surviving sources drift apart', async () => {
    const tight = await judge({ 'SOL/USD': { price: 200, dispersion: 0 } });
    const loose = await judge({ 'SOL/USD': { price: 200, dispersion: 0.015 } });
    expect(loose.confidence).toBeLessThan(tight.confidence);
  });

  it('accepts a minute-grained exchange sample without calling it stale', async () => {
    // Candle sources are dated at the midpoint of their bucket, so a 30s skew
    // is the normal case, not a stalled feed.
    const result = await judge({ 'SOL/USD': { price: 200, skewSec: 30 } });
    expect(result.outcome).toBe('confirmed');
  });

  it('records which sources answered and which did not', async () => {
    const result = await judge({ 'SOL/USD': { price: 200 } });
    const consensus = result.details.consensus as {
      minSourceCount: number;
      bySources: Record<string, { contributors: string[] }>;
    };
    expect(consensus.minSourceCount).toBe(4);
    expect(consensus.bySources['SOL/USD'].contributors).toEqual([
      'pyth',
      'binance',
      'coinbase',
      'kraken',
    ]);
  });

  it('retries when every source is down at once', async () => {
    const result = await judge({ 'SOL/USD': { price: 200, unavailable: true } });
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('price_source_unavailable');
    expect(result.retryAfterSec).toBe(42);
  });
});

describe('OracleManipulation verifier — manipulation signatures (Phase 4)', () => {
  const BLOCK_TIME = 1_699_000_123;

  async function judge(feeds: Parameters<typeof mkPricer>[0], tx = mkSwapTx(250, 1, { timestamp: BLOCK_TIME })) {
    return verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer(feeds),
    );
  }

  it('confirms when the reference held still while the fill sat far off it', async () => {
    // Every independent reference unchanged either side of the transaction:
    // the dislocation was local to the venue, which is what manipulation
    // looks like from outside.
    const result = await judge({ 'SOL/USD': 200 });
    expect(result.outcome).toBe('confirmed');
    const sig = result.details.signatures as { present: string[] };
    expect(sig.present).toContain('reference_held_while_fill_diverged');
  });

  it('escalates instead of paying when the market itself was moving', async () => {
    // The reference travels ~12% across the sampling window, comparable to
    // how far the fill sat off it. A gap like that during a move like that is
    // bad execution, not proof of an attack — and the honest answer is "ask a
    // human", not "pay" and not "deny".
    const result = await judge({
      'SOL/USD': { price: 200, baseTime: BLOCK_TIME, driftPerSec: 0.0002 },
    });
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('no_manipulation_signature');
  });

  it('raises the bar in a volatile window', async () => {
    const calm = await judge({ 'SOL/USD': 200 });
    const choppy = await judge({
      'SOL/USD': { price: 200, baseTime: BLOCK_TIME, driftPerSec: 0.0002 },
    });
    // Same fill, same reference at block time — but a threshold that ignores
    // volatility would treat these two identically.
    expect(choppy.details.threshold as number).toBeGreaterThan(
      calm.details.threshold as number,
    );
  });

  it('counts a flash loan as a signature in its own right', async () => {
    const tx = mkSwapTx(250, 1, {
      timestamp: BLOCK_TIME,
      instructions: [
        { programId: DEX_PROGRAM, accounts: [], data: '' },
        { programId: FLASH_LOAN_PROGRAM, accounts: [], data: '' },
      ],
    });
    const result = await judge(
      { 'SOL/USD': { price: 200, baseTime: BLOCK_TIME, driftPerSec: 0.0002 } },
      tx,
    );
    // The moving market alone would have escalated; borrow-and-repay inside
    // the same transaction is enough shape to confirm.
    expect(result.outcome).toBe('confirmed');
    const sig = result.details.signatures as { present: string[] };
    expect(sig.present).toContain('flash_loan_present');
  });

  it('is more confident with more signatures present', async () => {
    const tx = mkSwapTx(250, 1, {
      timestamp: BLOCK_TIME,
      instructions: [
        { programId: DEX_PROGRAM, accounts: [], data: '' },
        { programId: FLASH_LOAN_PROGRAM, accounts: [], data: '' },
      ],
    });
    const one = await judge({ 'SOL/USD': 200 });
    const two = await judge({ 'SOL/USD': 200 }, tx);
    expect(two.confidence).toBeGreaterThan(one.confidence);
  });

  it('records the checks it could not run rather than calling them absent', async () => {
    const result = await judge({ 'SOL/USD': 200 });
    const sig = result.details.signatures as {
      unevaluated: Array<{ id: string; reason: string }>;
    };
    // Pool displacement and liquidity drain need archival pool state. Saying
    // "not observed" would overstate what was checked.
    const ids = sig.unevaluated.map((u) => u.id);
    expect(ids).toContain('pool_displacement');
    expect(ids).toContain('liquidity_drain');
  });

  it('stays below the auto-pay confidence lane', async () => {
    const tx = mkSwapTx(2_000, 1, {
      timestamp: BLOCK_TIME,
      instructions: [
        { programId: DEX_PROGRAM, accounts: [], data: '' },
        { programId: FLASH_LOAN_PROGRAM, accounts: [], data: '' },
      ],
    });
    const result = await judge({ 'SOL/USD': 200 }, tx);
    expect(result.outcome).toBe('confirmed');
    // Nothing off-chain should be able to release funds automatically until
    // settlement can verify the price evidence on-chain.
    expect(result.confidence).toBeLessThan(0.95);
  });

  it('escalates a lending oracle interaction instead of denying it', async () => {
    // Inflate a collateral price, borrow against it, walk away. No swap
    // happens, so the swap-shaped analysis has nothing to score — but
    // "not a trade" is not "not a loss".
    const tx = mkTx({
      timestamp: BLOCK_TIME,
      instructions: [{ programId: KAMINO_PROGRAM, accounts: [], data: '' }],
      accountData: [
        mkTokenDelta('a1', USDC_MINT, 500_000_000, 6),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    });
    const result = await judge({ 'SOL/USD': 200 }, tx);
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('lending_oracle_exposure');
  });

  it('still rejects a transaction that touches neither a DEX nor a lender', async () => {
    const tx = mkTx({
      timestamp: BLOCK_TIME,
      instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '' }],
    });
    const result = await judge({ 'SOL/USD': 200 }, tx);
    expect(result.outcome).toBe('rejected');
    expect(result.details.reason).toBe('no_dex_interaction');
  });
});

describe('OracleManipulation verifier — on-chain proof inputs (Phase 6)', () => {
  const BLOCK_TIME = 1_699_000_123;
  const SOL_FEED_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

  async function judge(feeds: Parameters<typeof mkPricer>[0]) {
    const tx = mkSwapTx(250, 1, { timestamp: BLOCK_TIME });
    return verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer(feeds),
    );
  }

  it('hands the settlement path everything the program checks', async () => {
    const result = await judge({ 'SOL/USD': { price: 200, pythFeedId: SOL_FEED_HEX } });
    expect(result.outcome).toBe('confirmed');

    const proof = result.details.proof as Record<string, unknown>;
    expect(proof.feedIdHex).toBe(SOL_FEED_HEX);
    // Pinned to Pyth's exponent so the program never rescales — getting this
    // wrong is an eight-orders-of-magnitude error.
    expect(proof.expo).toBe(-8);
    expect(proof.executedPriceScaled).toBe(250 * 1e8);
    expect(proof.observedReferencePriceScaled).toBe(200 * 1e8);
    expect(proof.subjectQuantity).toBe(1e9);
    expect(proof.subjectDecimals).toBe(9);
    expect(proof.signedUpdateHex).toBe('ab01');
  });

  it('produces no proof when no source supplied a signed update', async () => {
    // Exchange REST responses are unsigned. Without Pyth's Wormhole update
    // there are no bytes for the receiver to verify, so the claim cannot be
    // settled on the proven path at all.
    const result = await judge({
      'SOL/USD': { price: 200, pythFeedId: SOL_FEED_HEX, raw: null },
    });
    expect(result.outcome).toBe('confirmed');
    expect(result.details.proof).toBeNull();
  });

  it('bounds the payout by what the signed price can account for', async () => {
    const result = await judge({ 'SOL/USD': { price: 200, pythFeedId: SOL_FEED_HEX } });
    const proof = result.details.proof as { executedPriceScaled: number; subjectQuantity: number };

    // The program recomputes exactly this and refuses to pay more.
    const delta = Math.abs(proof.executedPriceScaled - 200 * 1e8);
    const maxProvableLoss = (delta * proof.subjectQuantity * 1e6) / (1e8 * 1e9);
    expect(result.lossAmount).toBeLessThanOrEqual(maxProvableLoss);
  });
});

describe('OracleManipulation verifier — block-time anchoring (Phase 1)', () => {
  it('prices against the transaction block time, never spot', async () => {
    const tx = mkSwapTx(250, 1, { timestamp: 1_699_000_123 });
    const pricer = mkPricer({ 'SOL/USD': 200 });

    await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      pricer,
    );

    // The window must be requested at the block time. Asking for spot is the
    // original bug: it measures market drift since execution, not the fill.
    const getPriceWindow = pricer.getPriceWindow as unknown as ReturnType<typeof vi.fn>;
    expect(getPriceWindow).toHaveBeenCalledWith('SOL/USD', 1_699_000_123, expect.any(Number));
  });

  it('retries rather than denies when the price source is unavailable', async () => {
    const tx = mkSwapTx(250, 1);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': { price: 200, unavailable: true } }),
    );

    // A 429 must never close a valid claim.
    expect(result.outcome).toBe('indeterminate');
    expect(result.verified).toBe(false);
    expect(result.details.reason).toBe('price_source_unavailable');
    expect(result.retryAfterSec).toBe(42);
  });

  it('refuses to price against a sample far from the block time', async () => {
    const tx = mkSwapTx(250, 1);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': { price: 200, skewSec: 600 } }),
    );

    // A stalled feed is a fact about the feed. Pricing a swap against a
    // sample ten minutes away would invent the deviation.
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('price_too_far_from_block_time');
  });

  it('is indeterminate when the block time cannot be established', async () => {
    const tx = mkSwapTx(250, 1, { timestamp: 0 });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('no_block_time');
  });

  it('widens the threshold by the reference confidence interval', async () => {
    // 4% deviation clears the fixed 3% bar, but the feed itself is only
    // confident to +/- 2% — three of those intervals is 6%, so the move sits
    // inside the reference's own uncertainty.
    const tx = mkSwapTx(208, 1);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': { price: 200, conf: 4 } }),
    );

    expect(result.outcome).toBe('rejected');
    expect(result.details.reason).toBe('deviation_below_threshold');
    // Threshold is three confidence intervals wide, aggregated across both
    // legs, so it lands well above the 4% move and above the fixed 3% bar.
    expect(result.details.threshold as number).toBeGreaterThan(
      result.details.deviation as number,
    );
    expect(result.details.threshold as number).toBeGreaterThan(0.06);
  });

  it('routes an unregistered mint to review instead of denying the claim', async () => {
    const unknownMint = 'UnknownMint1111111111111111111111111111111';
    const tx = mkSwapTx(250, 1, {}, unknownMint, 9);

    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );

    // Missing feed coverage is our gap, not evidence about the trade.
    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('no_price_feed_for_mint');
  });

  it('attaches a replayable evidence bundle to the verdict', async () => {
    const tx = mkSwapTx(250, 1, { timestamp: 1_699_000_123, slot: 987_654 });
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );

    expect(result.outcome).toBe('confirmed');
    expect(result.evidence).toBeDefined();
    expect(result.evidence?.blockTime).toBe(1_699_000_123);
    expect(result.evidence?.slot).toBe(987_654);
    expect(result.evidence?.prices.length).toBeGreaterThan(0);
    // The signed proof blob must survive into the bundle — it is what makes
    // the price checkable by someone who does not trust us.
    expect(result.evidence?.prices[0].raw).toBe('ab01');
    expect(result.details.bundleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('discounts confidence when the price sample sits further from the block', async () => {
    const tight = await verifyClaim(
      TriggerType.OracleManipulation,
      mkSwapTx(250, 1).signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(mkSwapTx(250, 1)),
      mkPricer({ 'SOL/USD': 200 }),
    );
    const loose = await verifyClaim(
      TriggerType.OracleManipulation,
      mkSwapTx(250, 1).signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(mkSwapTx(250, 1)),
      // Within the consensus tolerance, but half a minute of market can
      // happen in 30 seconds and the verdict should say so.
      mkPricer({ 'SOL/USD': { price: 200, skewSec: 30 } }),
    );

    expect(tight.outcome).toBe('confirmed');
    expect(loose.outcome).toBe('confirmed');
    expect(loose.confidence).toBeLessThan(tight.confidence);
  });

  it('never reaches the auto-pay confidence lane on single-source price alone', async () => {
    // Even a 10x overpay: without independent sources (Phase 3) and a
    // structural signature (Phase 4), price divergence must not clear 0.95.
    const tx = mkSwapTx(2_000, 1);
    const result = await verifyClaim(
      TriggerType.OracleManipulation,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({ 'SOL/USD': 200 }),
    );
    expect(result.outcome).toBe('confirmed');
    expect(result.confidence).toBeLessThan(0.95);
  });
});

describe('GovernanceAttack verifier — dispatch', () => {
  /**
   * Only the dispatch contract is asserted here. The verdict logic lives in
   * `governance-adjudicate.test.ts` and `governance-corpus.test.ts`, where it
   * can be driven with a chain record instead of an indexer payload.
   */

  it('cannot resolve a takeover from the indexer payload alone', async () => {
    // No connection: no signer flags, no per-side token account owners. The
    // old verifier answered anyway, off which programs it saw; this one says
    // it cannot tell, and retries.
    const tx = mkTx({ instructions: [{ programId: GOV_PROGRAM, accounts: [], data: '' }] });
    const result = await verifyClaim(
      TriggerType.GovernanceAttack,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({}),
    );

    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).toBe('no_chain_record');
    expect(result.lossAmount).toBe(0);
  });

  it('never confirms without a governance program, and never rejects for lacking one', async () => {
    // Both halves of the old verifier's mistake, in one assertion. A real
    // takeover of an agent invokes no DAO program at all.
    const tx = mkTx({ instructions: [{ programId: UNKNOWN_PROGRAM, accounts: [], data: '' }] });
    const result = await verifyClaim(
      TriggerType.GovernanceAttack,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({}),
    );

    expect(result.outcome).toBe('indeterminate');
    expect(result.details.reason).not.toBe('no_governance_program');
  });

  it('carries an evidence bundle even when it cannot decide', async () => {
    // A bundle with nothing in it helps nobody, but a claim with no bundle at
    // all is unreplayable — which is what every governance claim used to be.
    const tx = mkTx({ instructions: [{ programId: GOV_PROGRAM, accounts: [], data: '' }] });
    const result = await verifyClaim(
      TriggerType.GovernanceAttack,
      tx.signature,
      AGENT,
      COVERAGE_RAW,
      mkHelius(tx),
      mkPricer({}),
    );

    expect(result.evidence).toBeDefined();
    expect(result.evidence?.triggerType).toBe(TriggerType.GovernanceAttack);
    expect(result.evidence?.txSignature).toBe(tx.signature);
  });
});
