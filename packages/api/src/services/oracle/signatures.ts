import type { SolanaReader } from '../../utils/solana-reader.js';
import { fetchRawTxView } from '../exploit/raw-tx.js';
import { logger } from '../../utils/logger.js';
import type { EnhancedTransaction } from '../../utils/helius.js';
import type { ProgramClassification } from '../verifiers/common.js';
import { relativeSpread } from './consensus.js';
import { isSourceUnavailable, type PriceOracle, type PriceSourceId } from './types.js';

/**
 * Structural evidence that a bad fill was an attack rather than a bad trade.
 *
 * A price being far from the reference is not, by itself, manipulation. Thin
 * liquidity, a stale route, a genuinely volatile minute and an agent with its
 * slippage tolerance set to 50% all produce the same number. What separates
 * them is *shape*, and shape is what this module looks for.
 *
 * The strongest available signal is the one below called
 * `reference_held_while_fill_diverged`. Real market moves show up everywhere
 * at once; a manipulated pool dislocates on its own while every independent
 * reference carries on unchanged. Sampling the reference either side of the
 * transaction distinguishes the two without needing the pool's own state.
 *
 * Two signals from the plan are not implemented here and are reported as
 * unevaluated rather than absent, because pretending to have checked is worse
 * than admitting we did not: same-slot pool displacement and
 * liquidity-drain-and-restore both need pool reserves at a specific slot,
 * which standard RPC will not serve for historical slots. They arrive with
 * the archival pool-state source.
 */

export type SignatureId =
  | 'reference_held_while_fill_diverged'
  | 'oracle_conf_blowout'
  | 'dispersion_spike'
  | 'flash_loan_present'
  | 'sandwich_adjacent'
  | 'pool_displacement'
  | 'liquidity_drain'
  /** Exculpatory: the fill moved because the agent's own order was most of
   *  the venue's depth. Never counts towards the manipulation score. */
  | 'venue_depth_self_inflicted'
  /** Exculpatory: the venue is an order book, so the transaction's net
   *  balance change need not be one exchange at all. */
  | 'orderbook_settlement';

export interface SignatureFinding {
  id: SignatureId;
  /** `null` means the check could not run — never conflate with "absent". */
  present: boolean | null;
  /** Contribution to the evidence score when present. */
  weight: number;
  detail: Record<string, unknown>;
}

export interface SignatureReport {
  findings: SignatureFinding[];
  /** Signatures positively observed. */
  present: SignatureId[];
  /** Signatures that could not be evaluated, with the reason. */
  unevaluated: Array<{ id: SignatureId; reason: string }>;
  /** Summed weight of what was observed. */
  score: number;
  /** Realised volatility of the reference across the sampling window, as a
   *  fraction. Feeds the adaptive deviation threshold. */
  referenceVolatility: number | null;
  /** How far the reference travelled relative to how far the fill sat off it. */
  referenceDriftRatio: number | null;
  sampledAt: number[];
}

export interface SignatureContext {
  tx: EnhancedTransaction;
  programs: ProgramClassification;
  blockTime: number;
  slot: number | null;
  oracle: PriceOracle;
  /** The insured wallet. Needed to tell the agent's own accounts from the
   *  venue's, which is the whole of the depth calculation. */
  agentAddress: string;
  /** Feed of the leg carrying the deviation. */
  subjectFeedKey: string;
  /** Price the fill implies for that leg's asset. */
  impliedPrice: number;
  /** Agreed reference price at the block time. */
  referencePrice: number;
  /** Dispersion between sources at the block time. */
  referenceDispersion: number;
  /** Reference confidence as a fraction of price at the block time. */
  referenceConfFraction: number;
  reader?: SolanaReader | null;
}

/** Offsets around the transaction at which the reference is re-sampled.
 *  Wide enough to catch a real move developing, tight enough that unrelated
 *  market activity does not dominate. */
const SAMPLE_OFFSETS_SEC = [-300, -60, 60, 300];

/** A reference that moved less than this fraction of the fill's own
 *  divergence did not follow the fill anywhere. */
const REFERENCE_HELD_RATIO = 0.5;

/** Confidence or dispersion this many times its own recent baseline is a
 *  dislocation, not noise. */
const BLOWOUT_MULTIPLE = 3;

/**
 * Signatures that argue *against* manipulation.
 *
 * They are findings like any other and belong in the bundle, but they must
 * never reach `present[]` or `score`: the adjudicator treats a non-empty
 * `present[]` as "there is a manipulation shape here", and an exculpatory
 * finding satisfying that test would be precisely backwards.
 */
const EXCULPATORY: ReadonlySet<SignatureId> = new Set([
  'venue_depth_self_inflicted',
  'orderbook_settlement',
]);

/** Below this share of a venue's pre-trade reserve, an order is a price
 *  taker and its own impact is not the story. */
const DEPTH_SHARE_FLOOR = 0.1;

export async function collectSignatures(ctx: SignatureContext): Promise<SignatureReport> {
  const findings: SignatureFinding[] = [];
  const unevaluated: Array<{ id: SignatureId; reason: string }> = [];

  // --- flash loan: free to check, and a strong co-occurrence signal --------
  findings.push({
    id: 'flash_loan_present',
    present: ctx.programs.flashLoan,
    weight: 0.3,
    detail: { note: 'Borrow-and-repay inside one transaction is the usual funding for a squeeze.' },
  });

  // --- reference behaviour around the transaction --------------------------
  const series = await sampleReference(ctx);
  let referenceVolatility: number | null = null;
  let referenceDriftRatio: number | null = null;

  if (series.samples.length < 2) {
    unevaluated.push({ id: 'reference_held_while_fill_diverged', reason: series.reason });
    unevaluated.push({ id: 'dispersion_spike', reason: series.reason });
    unevaluated.push({ id: 'oracle_conf_blowout', reason: series.reason });
  } else {
    const prices = series.samples.map((s) => s.price);
    referenceVolatility = relativeSpread(prices) / 2;

    // How far the fill sat from the reference, versus how far the reference
    // itself travelled over the same window.
    const fillDivergence = Math.abs(ctx.impliedPrice - ctx.referencePrice) / ctx.referencePrice;
    const referenceTravel = relativeSpread([...prices, ctx.referencePrice]);
    referenceDriftRatio = fillDivergence > 0 ? referenceTravel / fillDivergence : null;

    findings.push({
      id: 'reference_held_while_fill_diverged',
      present: referenceDriftRatio !== null && referenceDriftRatio < REFERENCE_HELD_RATIO,
      weight: 0.4,
      detail: {
        fillDivergence,
        referenceTravel,
        referenceDriftRatio,
        threshold: REFERENCE_HELD_RATIO,
        note:
          'A real move shows up in every reference. A reference that never budged while the ' +
          'fill sat far away means the dislocation was local to the venue.',
      },
    });

    const baselineDispersion = medianOf(series.samples.map((s) => s.dispersion));
    findings.push({
      id: 'dispersion_spike',
      present:
        baselineDispersion > 0
          ? ctx.referenceDispersion > baselineDispersion * BLOWOUT_MULTIPLE
          : ctx.referenceDispersion > 0.005,
      weight: 0.2,
      detail: {
        atBlockTime: ctx.referenceDispersion,
        baseline: baselineDispersion,
        multiple: BLOWOUT_MULTIPLE,
        note: 'Sources agreeing before and after but not during is what one corrupted feed looks like.',
      },
    });

    const baselineConf = medianOf(series.samples.map((s) => s.confFraction));
    findings.push({
      id: 'oracle_conf_blowout',
      present:
        baselineConf > 0 ? ctx.referenceConfFraction > baselineConf * BLOWOUT_MULTIPLE : false,
      weight: 0.15,
      detail: {
        atBlockTime: ctx.referenceConfFraction,
        baseline: baselineConf,
        note: 'Publishers disagreeing among themselves at exactly this moment.',
      },
    });
  }

  // --- same-block adjacency (sandwich) -------------------------------------
  const sandwich = await detectSandwich(ctx);
  if (sandwich.present === null) {
    unevaluated.push({ id: 'sandwich_adjacent', reason: sandwich.reason ?? 'unavailable' });
  } else {
    findings.push({
      id: 'sandwich_adjacent',
      present: sandwich.present,
      weight: 0.35,
      detail: sandwich.detail,
    });
  }

  // --- was this an order book rather than a swap? --------------------------
  findings.push({
    id: 'orderbook_settlement',
    present: ctx.programs.orderBook,
    weight: 0,
    detail: {
      note:
        'A central-limit order book was invoked. Posting an order and settling an earlier ' +
        'one happen in the same transaction, so the net balance change is not necessarily ' +
        'a single fill and the implied price derived from it is not necessarily a price.',
    },
  });

  // --- did the agent's own order move the venue? ----------------------------
  const depth = await measureVenueDepthImpact(ctx);
  if (depth.present === null) {
    unevaluated.push({ id: 'venue_depth_self_inflicted', reason: depth.reason });
  } else {
    findings.push({
      id: 'venue_depth_self_inflicted',
      present: depth.present,
      weight: 0,
      detail: depth.detail,
    });
  }

  // --- not yet implementable ------------------------------------------------
  unevaluated.push({ id: 'pool_displacement', reason: 'needs_archival_pool_state' });
  unevaluated.push({ id: 'liquidity_drain', reason: 'needs_archival_pool_state' });

  const scored = findings.filter((f) => f.present === true && !EXCULPATORY.has(f.id));
  const present = scored.map((f) => f.id);
  const score = scored.reduce((sum, f) => sum + f.weight, 0);

  return {
    findings,
    present,
    unevaluated,
    score: Number(score.toFixed(4)),
    referenceVolatility,
    referenceDriftRatio,
    sampledAt: series.samples.map((s) => s.at),
  };
}

/**
 * How much of the venue's own reserve the agent's order consumed.
 *
 * A constant-product pool prices an order against its reserves, so an order
 * that takes most of one side moves the price by arithmetic, not by anyone's
 * intent. The distinction matters more than it might sound: "the fill was far
 * off every reference and the references never moved" is *also* what taking
 * three quarters of a pool looks like, which is how the first real
 * transaction this pipeline was ever backtested against — the Wormhole
 * attacker buying $18M of SOL out of a pool holding 162,000 — came back
 * confirmed as oracle manipulation with a $5M loss.
 *
 * The measurement needs the venue's balance *before* the trade, and the
 * transaction carries it: `preTokenBalances` covers every account the
 * transaction touched, the agent's and the venue's alike. That is why this
 * runs where `pool_displacement` cannot. Displacement asks what a third party
 * did to the pool beforehand and genuinely needs an archival slot read; this
 * asks only what the agent's own order did, and the answer is in the
 * transaction's own record.
 *
 * Reported as the largest share taken from any single account the agent does
 * not own. Absent an owner on a balance entry the account is skipped rather
 * than assumed foreign — attributing the agent's own vault to the venue would
 * invent an impact that never happened.
 */
async function measureVenueDepthImpact(ctx: SignatureContext): Promise<{
  present: boolean | null;
  reason: string;
  detail: Record<string, unknown>;
}> {
  if (!ctx.reader) {
    return { present: null, reason: 'no_connection', detail: {} };
  }

  const view = await fetchRawTxView(ctx.reader, ctx.tx.signature);
  if (!view) return { present: null, reason: 'chain_record_unavailable', detail: {} };

  const before = new Map<string, { amountRaw: number; owner: string | null; mint: string }>();
  for (const snap of view.preTokenBalances) {
    before.set(snap.account, { amountRaw: snap.amountRaw, owner: snap.owner, mint: snap.mint });
  }

  let worst: {
    account: string;
    mint: string;
    share: number;
    preRaw: number;
    takenRaw: number;
  } | null = null;

  for (const snap of view.postTokenBalances) {
    const pre = before.get(snap.account);
    if (!pre || pre.owner === null || pre.owner === ctx.agentAddress) continue;
    if (pre.amountRaw <= 0) continue;

    // Only reserves the agent drew *down*. A venue account that grew is the
    // side the agent paid into, and paying into a pool is not price impact
    // the agent suffered.
    const taken = pre.amountRaw - snap.amountRaw;
    if (taken <= 0) continue;

    const share = taken / pre.amountRaw;
    if (!worst || share > worst.share) {
      worst = {
        account: snap.account,
        mint: pre.mint,
        share,
        preRaw: pre.amountRaw,
        takenRaw: taken,
      };
    }
  }

  if (!worst) {
    return {
      present: false,
      reason: 'no_venue_reserve_drawn',
      detail: { note: 'No account outside the agent gave up a balance it held before.' },
    };
  }

  return {
    present: worst.share >= DEPTH_SHARE_FLOOR,
    reason: 'measured',
    detail: {
      depthShare: Number(worst.share.toFixed(6)),
      account: worst.account,
      mint: worst.mint,
      reserveBeforeRaw: worst.preRaw,
      takenRaw: worst.takenRaw,
      floor: DEPTH_SHARE_FLOOR,
      note:
        'Share of a single venue reserve consumed by this order. A large share means the ' +
        "fill price is the pool's curve answering the order's own size.",
    },
  };
}

interface ReferenceSample {
  at: number;
  price: number;
  dispersion: number;
  confFraction: number;
}

/**
 * Re-price the subject feed either side of the transaction.
 *
 * Sources are queried concurrently; a source that is down at one offset
 * simply thins that sample rather than aborting the whole check. Too few
 * usable samples leaves the dependent signatures unevaluated, which routes
 * the claim to review — the correct outcome when we cannot see enough to
 * judge.
 */
async function sampleReference(
  ctx: SignatureContext,
): Promise<{ samples: ReferenceSample[]; reason: string }> {
  const results = await Promise.all(
    SAMPLE_OFFSETS_SEC.map(async (offset) => {
      const at = ctx.blockTime + offset;
      try {
        const window = await ctx.oracle.getPriceWindow(ctx.subjectFeedKey, at);
        if (!window || !(window.anchor.value > 0)) return null;
        return {
          at,
          price: window.anchor.value,
          dispersion: window.dispersion ?? 0,
          confFraction: window.anchor.conf / window.anchor.value,
        } satisfies ReferenceSample;
      } catch (err) {
        if (isSourceUnavailable(err)) return null;
        logger.warn({ err, at, feed: ctx.subjectFeedKey }, 'signatures: reference sample failed');
        return null;
      }
    }),
  );

  const samples = results.filter((s): s is ReferenceSample => s !== null);
  return {
    samples,
    reason: samples.length === 0 ? 'no_reference_samples' : 'too_few_reference_samples',
  };
}

/** Accounts that appear in most transactions and so carry no information
 *  about two transactions touching the same venue. */
const UBIQUITOUS_ACCOUNTS = new Set([
  '11111111111111111111111111111111', // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  'ComputeBudget111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
]);

/**
 * Was the agent's transaction bracketed in the same block by transactions
 * touching the same accounts?
 *
 * A squeeze needs the price moved just before the victim's fill and released
 * just after, which forces the attacker into the same block on the same pool
 * accounts. That adjacency is visible from the block alone, without knowing
 * anything about the pool's internals.
 *
 * Standard RPC will not serve historical blocks indefinitely, so failure here
 * is reported as "could not check".
 */
async function detectSandwich(ctx: SignatureContext): Promise<{
  present: boolean | null;
  reason?: string;
  detail: Record<string, unknown>;
}> {
  if (!ctx.reader || ctx.slot === null) {
    return { present: null, reason: 'no_connection_or_slot', detail: {} };
  }

  try {
    const block = await ctx.reader.getBlockAccounts(ctx.slot);
    if (!block) return { present: null, reason: 'block_unavailable', detail: {} };

    // `transactionDetails: 'accounts'` returns account keys per transaction
    // instead of full instruction data — a fraction of the payload, and all
    // this check needs.
    const txs = block.transactions;
    const index = txs.findIndex((t) =>
      (t.transaction?.signatures ?? []).includes(ctx.tx.signature),
    );
    if (index < 0) return { present: null, reason: 'tx_not_in_block', detail: {} };

    const keysOf = (i: number): Set<string> => {
      const keys = txs[i]?.transaction?.accountKeys ?? [];
      return new Set(
        keys
          .map((k) => (typeof k === 'string' ? k : String(k.pubkey ?? '')))
          .filter((k) => k.length > 0 && !UBIQUITOUS_ACCOUNTS.has(k)),
      );
    };

    const subject = keysOf(index);
    const before = index > 0 ? keysOf(index - 1) : new Set<string>();
    const after = index < txs.length - 1 ? keysOf(index + 1) : new Set<string>();

    const sharedBefore = [...before].filter((k) => subject.has(k));
    const sharedAfter = [...after].filter((k) => subject.has(k));
    // Bracketed on both sides, sharing venue accounts with each: the shape a
    // squeeze leaves behind. One side alone is ordinary block traffic.
    const bracketed = sharedBefore.length > 0 && sharedAfter.length > 0;
    // The same counterparty on both sides is far more telling than two
    // unrelated neighbours that happen to touch the same pool.
    const sameNeighbour = sharedBefore.filter((k) => sharedAfter.includes(k));

    return {
      present: bracketed && sameNeighbour.length > 0,
      detail: {
        indexInBlock: index,
        blockTxCount: txs.length,
        sharedWithPrevious: sharedBefore.length,
        sharedWithNext: sharedAfter.length,
        sharedBothSides: sameNeighbour.length,
      },
    };
  } catch (err) {
    return {
      present: null,
      reason: `block_fetch_failed:${err instanceof Error ? err.message : String(err)}`,
      detail: {},
    };
  }
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

export type { PriceSourceId };
