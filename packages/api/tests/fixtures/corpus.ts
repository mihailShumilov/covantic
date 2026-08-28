import { vi } from 'vitest';
import type { EnhancedTransaction } from '../../src/utils/helius.js';
import type { HeliusClient } from '../../src/utils/helius.js';
import {
  PriceSourceUnavailableError,
  type PriceOracle,
  type PricePoint,
  type PriceSourceId,
  type PriceWindow,
} from '../../src/services/oracle/types.js';

/**
 * Labelled corpus for the oracle-manipulation verifier.
 *
 * The negatives are the half that matters. Recall can be argued about; a
 * false positive is the vault paying out for a trade that was merely bad,
 * and once one of those ships the protocol is insuring ordinary slippage.
 * So the gate is asymmetric: zero confirmations on the negatives is a hard
 * CI failure, while recall on the positives is a tracked number with a floor.
 *
 * What is here and what is not:
 *   - the negatives below are hand-built from the failure modes that actually
 *     produced wrong answers during development — volatile markets, thin
 *     pools, wrap/unwrap, multi-hop routing, unpriceable mints;
 *   - the positives are manipulation *shapes* (reference held while the fill
 *     diverged, flash-loan co-occurrence), not replays of real incidents.
 *
 * Real mainnet transactions live next door, in
 * `tests/incident-backtest.test.ts` and `fixtures/incidents/`. That corpus
 * covers what this one structurally cannot — transactions nobody imagined —
 * and it found two false positives on its first run that every case here
 * passes. Neither file replaces the other: this one pins the specific answers
 * that must not regress, that one asks whether the answers hold up against
 * traffic nobody chose.
 */

export const AGENT = 'AgentWalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const OTHER = 'OtherWalletbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const DEX_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const FLASH_LOAN_PROGRAM = 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo';
export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
export const UNKNOWN_MINT = 'UnknownMint1111111111111111111111111111111';
export const SOL_FEED_HEX = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

export const BLOCK_TIME = 1_700_000_000;
export const COVERAGE_RAW = 1_000_000 * 10 ** 6;

export interface FeedSpec {
  price: number | null;
  conf?: number;
  sources?: number;
  dispersion?: number;
  skewSec?: number;
  unavailable?: boolean;
  /** Fractional price change per second away from BLOCK_TIME — a real market
   *  move, which every independent reference follows. */
  driftPerSec?: number;
  pythFeedId?: string;
  raw?: string | null;
}

export interface CorpusCase {
  name: string;
  /** `positive` = a manipulation the verifier should confirm.
   *  `negative` = anything it must not confirm, whatever the reason. */
  label: 'positive' | 'negative';
  /** Why this case exists, for whoever reads a failure. */
  why: string;
  tx: EnhancedTransaction;
  feeds: Record<string, FeedSpec>;
  coverageRaw?: number;
}

const SOURCE_IDS: PriceSourceId[] = ['pyth', 'binance', 'coinbase', 'kraken'];

export function mkPricer(feeds: Record<string, FeedSpec>): PriceOracle {
  return {
    async getPriceWindow(feedKey: string, targetTime: number): Promise<PriceWindow | null> {
      const feed = feeds[feedKey];
      if (!feed) return null;
      if (feed.unavailable) {
        throw new PriceSourceUnavailableError('consensus', 'corpus: sources down', {
          retryAfterSec: 30,
        });
      }
      if (feed.price === null) return null;

      const offset = targetTime - BLOCK_TIME;
      const drifted = feed.price * (1 + (feed.driftPerSec ?? 0) * offset);
      const skewSec = feed.skewSec ?? 0;
      const sourceCount = feed.sources ?? 4;
      const dispersion = feed.dispersion ?? 0;

      const mk = (source: PriceSourceId, value: number): PricePoint => ({
        value,
        conf: feed.conf ?? 0,
        publishTime: targetTime - skewSec,
        slot: 1_000,
        source,
        feedId: source === 'pyth' && feed.pythFeedId ? feed.pythFeedId : feedKey,
        raw: source === 'pyth' ? (feed.raw === undefined ? 'ab01' : feed.raw) : null,
      });

      const contributors = SOURCE_IDS.slice(0, sourceCount).map((id, i) =>
        mk(id, drifted * (1 + (i === 0 ? 0 : dispersion))),
      );
      const anchor = mk('consensus', drifted);

      return {
        feedId: feedKey,
        source: 'consensus',
        targetTime,
        before: anchor,
        after: anchor,
        anchor,
        skewSec,
        contributors,
        dispersion,
        sourceCount,
        missing: [],
      };
    },
  };
}

export function mkHelius(tx: EnhancedTransaction | null): HeliusClient {
  return { getParsedTransaction: vi.fn(async () => tx) } as unknown as HeliusClient;
}

function delta(account: string, mint: string, raw: number, decimals: number) {
  return {
    account,
    nativeBalanceChange: 0,
    tokenBalanceChanges: [
      { mint, rawTokenAmount: { tokenAmount: String(raw), decimals }, userAccount: AGENT },
    ],
  };
}

export function mkTx(partial: Partial<EnhancedTransaction> = {}): EnhancedTransaction {
  return {
    signature: 'SigCorpus',
    timestamp: BLOCK_TIME,
    slot: 500_000,
    type: 'SWAP',
    source: 'JUPITER',
    fee: 5_000,
    feePayer: AGENT,
    transactionError: null,
    instructions: [{ programId: DEX_PROGRAM, accounts: [], data: '' }],
    tokenTransfers: [],
    nativeTransfers: [],
    accountData: [],
    ...partial,
  };
}

/** A DEX swap: the agent pays `usdc` and receives `sol` SOL. */
export function swap(usdc: number, sol: number, partial: Partial<EnhancedTransaction> = {}) {
  return mkTx({
    accountData: [
      delta('ata-usdc', USDC_MINT, -Math.round(usdc * 1e6), 6),
      delta('ata-sol', WRAPPED_SOL, Math.round(sol * 1e9), 9),
      { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
    ],
    ...partial,
  });
}

const CALM: FeedSpec = { price: 200, pythFeedId: SOL_FEED_HEX };

// ---------------------------------------------------------------------------
// Corpus B — hard negatives. Zero of these may be confirmed.
// ---------------------------------------------------------------------------

export const NEGATIVES: CorpusCase[] = [
  {
    name: 'fair fill',
    label: 'negative',
    why: 'Executed at the reference. The base case that must never pay.',
    tx: swap(200, 1),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'fill inside the fee',
    label: 'negative',
    why: 'A 0.25% gap costs less than trading honestly on a 30bps venue.',
    tx: swap(200.5, 1),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'ordinary slippage',
    label: 'negative',
    why: 'A 2% gap is normal execution on a mid-size trade, not an attack.',
    tx: swap(204, 1),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'volatile market, wide fill',
    label: 'negative',
    why: 'The reference moved as far as the fill did. Bad timing, not a squeeze.',
    tx: swap(250, 1),
    feeds: { 'SOL/USD': { ...CALM, driftPerSec: 0.0002 } },
  },
  {
    name: 'wide reference confidence',
    label: 'negative',
    why: 'The gap sits inside the interval the sources themselves published.',
    tx: swap(208, 1),
    feeds: { 'SOL/USD': { ...CALM, conf: 4 } },
  },
  {
    name: 'references disagree',
    label: 'negative',
    why: 'Sources 8% apart cannot establish a fair price; one of them is wrong.',
    tx: swap(250, 1),
    feeds: { 'SOL/USD': { ...CALM, dispersion: 0.08 } },
  },
  {
    name: 'single source',
    label: 'negative',
    why: 'One feed cannot prove a feed was manipulated. It may be the culprit.',
    tx: swap(250, 1),
    feeds: { 'SOL/USD': { ...CALM, sources: 1 } },
  },
  {
    name: 'two sources',
    label: 'negative',
    why: 'With two, a disagreement is unattributable.',
    tx: swap(250, 1),
    feeds: { 'SOL/USD': { ...CALM, sources: 2 } },
  },
  {
    name: 'no structural signature',
    label: 'negative',
    why: 'Off the reference, but nothing distinguishes it from bad execution.',
    tx: swap(250, 1),
    feeds: { 'SOL/USD': { ...CALM, driftPerSec: 0.0002 } },
  },
  {
    name: 'price sources unavailable',
    label: 'negative',
    why: 'An outage says nothing. Must retry, never pay and never deny.',
    tx: swap(250, 1),
    feeds: { 'SOL/USD': { ...CALM, unavailable: true } },
  },
  {
    name: 'stale reference',
    label: 'negative',
    why: 'A sample ten minutes away would invent the deviation.',
    tx: swap(250, 1),
    feeds: { 'SOL/USD': { ...CALM, skewSec: 600 } },
  },
  {
    name: 'wrap and unwrap only',
    label: 'negative',
    why: 'Wrapping SOL is not a trade; net position is unchanged.',
    tx: mkTx({
      accountData: [
        delta('ata-sol', WRAPPED_SOL, 1_000_000_000, 9),
        { account: AGENT, nativeBalanceChange: -1_000_005_000, tokenBalanceChanges: [] },
      ],
    }),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'fee only',
    label: 'negative',
    why: 'Paying for the block is not an execution shortfall.',
    tx: mkTx({
      accountData: [{ account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] }],
    }),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'self transfer',
    label: 'negative',
    why: 'Value moved between the agent own accounts. Nothing was lost.',
    tx: mkTx({
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: AGENT,
          fromTokenAccount: 'a',
          toTokenAccount: 'b',
          tokenAmount: 5_000,
          mint: USDC_MINT,
          tokenStandard: 'Fungible',
        },
      ],
    }),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'one-way outflow',
    label: 'negative',
    why: 'No exchange rate is implied by a transfer. Not this verifier problem.',
    tx: mkTx({
      accountData: [
        delta('ata-usdc', USDC_MINT, -250_000_000, 6),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    }),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'unpriceable mint',
    label: 'negative',
    why: 'A coverage gap on our side. Review, never a confident payout.',
    tx: mkTx({
      accountData: [
        delta('ata-usdc', USDC_MINT, -250_000_000, 6),
        delta('ata-x', UNKNOWN_MINT, 1_000_000_000, 9),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    }),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'LST priced off its own feed',
    label: 'negative',
    why: 'JitoSOL trades above SOL. Pricing it off SOL/USD invents a shortfall.',
    tx: mkTx({
      accountData: [
        delta('ata-usdc', USDC_MINT, -250_000_000, 6),
        delta('ata-jito', JITOSOL_MINT, 1_000_000_000, 9),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    }),
    feeds: { 'SOL/USD': CALM, 'JITOSOL/USD': { price: 250 } },
  },
  {
    name: 'multi-hop route, fair overall',
    label: 'negative',
    why: 'Intermediate hops look terrible in isolation; the net position is fine.',
    tx: swap(200, 1, {
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER,
          fromTokenAccount: 'e',
          toTokenAccount: 'f',
          tokenAmount: 9_999,
          mint: WRAPPED_SOL,
          tokenStandard: 'Fungible',
        },
        {
          fromUserAccount: OTHER,
          toUserAccount: AGENT,
          fromTokenAccount: 'g',
          toTokenAccount: 'h',
          tokenAmount: 9_999,
          mint: WRAPPED_SOL,
          tokenStandard: 'Fungible',
        },
      ],
    }),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'many-to-many swap',
    label: 'negative',
    why: 'No single implied price exists. A reviewer can judge it; we cannot.',
    tx: mkTx({
      accountData: [
        delta('a1', USDC_MINT, -250_000_000, 6),
        delta('a2', WRAPPED_SOL, -1_000_000_000, 9),
        delta('a3', JITOSOL_MINT, 500_000_000, 9),
        delta('a4', UNKNOWN_MINT, 1_000, 9),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    }),
    feeds: { 'SOL/USD': CALM, 'JITOSOL/USD': { price: 250 } },
  },
  {
    name: 'no DEX involved',
    label: 'negative',
    why: 'Nothing was traded, so nothing was mispriced.',
    tx: mkTx({
      instructions: [
        { programId: 'UnknownProgram1111111111111111111111111111', accounts: [], data: '' },
      ],
      accountData: [
        delta('ata-usdc', USDC_MINT, -250_000_000, 6),
        delta('ata-sol', WRAPPED_SOL, 1_000_000_000, 9),
      ],
    }),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'agent received more than it paid',
    label: 'negative',
    why: 'A favourable fill is not a loss.',
    tx: swap(150, 1),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'dust trade off the reference',
    label: 'negative',
    why:
      'A trade of a few millionths of a dollar can be 30% off the reference ' +
      'and clear every percentage bar. Filing the claim costs more than the loss.',
    tx: swap(0.0000025, 0.00000001),
    feeds: { 'SOL/USD': CALM },
  },
];

// ---------------------------------------------------------------------------
// Corpus A/C — positives. Manipulation shapes the verifier should catch.
// ---------------------------------------------------------------------------

export const POSITIVES: CorpusCase[] = [
  {
    name: 'venue-local dislocation, 25% overpay',
    label: 'positive',
    why: 'Every reference held still while the fill sat far off it.',
    tx: swap(250, 1),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'venue-local dislocation, 10x overpay',
    label: 'positive',
    why: 'The unmistakable case. If this is missed, nothing works.',
    tx: swap(2_000, 1),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'flash-loan funded squeeze in a moving market',
    label: 'positive',
    why: 'The market was moving, but borrow-and-repay in one tx is its own signature.',
    tx: swap(250, 1, {
      instructions: [
        { programId: DEX_PROGRAM, accounts: [], data: '' },
        { programId: FLASH_LOAN_PROGRAM, accounts: [], data: '' },
      ],
    }),
    feeds: { 'SOL/USD': { ...CALM, driftPerSec: 0.0002 } },
  },
  {
    name: 'undersell: agent dumped SOL far below reference',
    label: 'positive',
    why: 'Manipulation works in both directions; the seller side must fire too.',
    tx: mkTx({
      accountData: [
        delta('ata-sol', WRAPPED_SOL, -10_000_000_000, 9),
        delta('ata-usdc', USDC_MINT, 1_500_000_000, 6),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    }),
    feeds: { 'SOL/USD': CALM },
  },
  {
    name: 'non-USDC pair squeeze',
    label: 'positive',
    why: 'Old verifier required a USDC leg and could not see this at all.',
    tx: mkTx({
      accountData: [
        delta('ata-sol', WRAPPED_SOL, -10_000_000_000, 9),
        delta('ata-jito', JITOSOL_MINT, 6_000_000_000, 9),
        { account: AGENT, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      ],
    }),
    feeds: { 'SOL/USD': CALM, 'JITOSOL/USD': { price: 250 } },
  },
  {
    name: 'squeeze split across a multi-hop route',
    label: 'positive',
    why: 'Routing does not hide the net position change.',
    tx: swap(250, 1, {
      tokenTransfers: [
        {
          fromUserAccount: AGENT,
          toUserAccount: OTHER,
          fromTokenAccount: 'e',
          toTokenAccount: 'f',
          tokenAmount: 9_999,
          mint: WRAPPED_SOL,
          tokenStandard: 'Fungible',
        },
      ],
    }),
    feeds: { 'SOL/USD': CALM },
  },
];

export const CORPUS: CorpusCase[] = [...NEGATIVES, ...POSITIVES];
