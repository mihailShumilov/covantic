import type { Connection } from '@solana/web3.js';
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
  | 'liquidity_drain';

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
  connection?: Connection | null;
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

  // --- not yet implementable ------------------------------------------------
  unevaluated.push({ id: 'pool_displacement', reason: 'needs_archival_pool_state' });
  unevaluated.push({ id: 'liquidity_drain', reason: 'needs_archival_pool_state' });

  const present = findings.filter((f) => f.present === true).map((f) => f.id);
  const score = findings
    .filter((f) => f.present === true)
    .reduce((sum, f) => sum + f.weight, 0);

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
  if (!ctx.connection || ctx.slot === null) {
    return { present: null, reason: 'no_connection_or_slot', detail: {} };
  }

  try {
    const block = await ctx.connection.getBlock(ctx.slot, {
      maxSupportedTransactionVersion: 0,
      transactionDetails: 'accounts',
      rewards: false,
    });
    if (!block) return { present: null, reason: 'block_unavailable', detail: {} };

    // `transactionDetails: 'accounts'` returns account keys per transaction
    // instead of full instruction data — a fraction of the payload, and all
    // this check needs. web3.js does not narrow its return type for that
    // variant, hence the local shape.
    const txs = (block.transactions ?? []) as unknown as AccountsOnlyTx[];
    const index = txs.findIndex((t) => (t.transaction?.signatures ?? []).includes(ctx.tx.signature));
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

/** Shape returned by `getBlock` under `transactionDetails: 'accounts'`. */
interface AccountsOnlyTx {
  transaction?: {
    signatures?: string[];
    accountKeys?: Array<string | { pubkey?: unknown }>;
  };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

export type { PriceSourceId };
