import type { ExecutionSummary } from './execution.js';
import type { SignatureReport } from './signatures.js';
import type { LegValuation } from './valuation.js';

/**
 * Shared vocabulary for the oracle-manipulation evidence spine.
 *
 * Design rule that everything here exists to enforce: **all network I/O
 * happens while building an {@link EvidenceBundle}; the adjudication that
 * reads the bundle is a pure function**. That split is what makes a verdict
 * reproducible — replaying a stored bundle must yield a byte-identical
 * verdict forever, with no clock and no network in the loop.
 */

/**
 * Independent price references.
 *
 * "Independent" is load-bearing. Adjudicating manipulation of a feed using
 * only that feed lets a manipulated oracle certify its own price as fair, so
 * a verdict must never rest on a single one of these. The CEX sources matter
 * disproportionately: they are the only references an on-chain attacker
 * cannot touch at all.
 */
export type PriceSourceId =
  | 'pyth'
  | 'binance'
  | 'coinbase'
  | 'kraken'
  | 'switchboard'
  | 'jupiter'
  | 'pool'
  /** Synthesised: the agreed value across several of the above. */
  | 'consensus';

/** One price observation from one source at one point in time. */
export interface PricePoint {
  /** Decimal price (already exponent-adjusted). */
  value: number;
  /** Source-reported uncertainty in the same units as `value`. Pyth's
   *  confidence interval; 0 when a source reports none. */
  conf: number;
  /** Unix seconds the source published this observation. */
  publishTime: number;
  /** Solana slot the observation belongs to, when the source reports one. */
  slot: number | null;
  source: PriceSourceId;
  /** Source-specific feed / pair identifier. */
  feedId: string;
  /**
   * Signed payload proving this observation, verbatim. For Pyth this is the
   * hex Wormhole accumulator update from Hermes `binary.data[0]` — the exact
   * bytes `pyth-solana-receiver` verifies on-chain. Retaining it is what
   * upgrades "our backend says the price was X" into "the guardians signed
   * that the price was X".
   */
  raw: string | null;
}

/**
 * The price samples bracketing a transaction's block time.
 *
 * Asking a feed for "the price" is meaningless without saying *when*. A
 * claim is always retrospective, so every price lookup is anchored to the
 * trigger transaction's block time, and the distance between the sample and
 * that block time (`skewSec`) is carried into the verdict rather than being
 * silently ignored.
 */
export interface PriceWindow {
  feedId: string;
  source: PriceSourceId;
  /** Block time of the trigger transaction, unix seconds. */
  targetTime: number;
  /** Latest sample with `publishTime <= targetTime`, if one exists. */
  before: PricePoint | null;
  /** Earliest sample with `publishTime >= targetTime`, if one exists. */
  after: PricePoint | null;
  /** The sample closest to `targetTime` — what the adjudicator prices against. */
  anchor: PricePoint;
  /** `|anchor.publishTime - targetTime|`, seconds. */
  skewSec: number;

  /** Every source that contributed, one anchor each. Present on consensus
   *  windows; a single-source window leaves it undefined. */
  contributors?: PricePoint[];
  /** Largest pairwise relative divergence between contributors. Wide
   *  dispersion means the references disagree, which proves nothing about the
   *  trade and must not be resolved by picking a favourite. */
  dispersion?: number;
  /** How many independent sources agreed. */
  sourceCount?: number;
  /** Sources that were asked but could not answer, with why. Kept in the
   *  bundle so a thin consensus is visible rather than implied. */
  missing?: Array<{ source: PriceSourceId; reason: string }>;
}

/**
 * One independent price reference.
 *
 * Implementations must throw {@link PriceSourceUnavailableError} when they
 * cannot answer for operational reasons, and return `null` only when the
 * source genuinely has no data for that feed at that time. Collapsing the two
 * turns an outage into evidence.
 */
export interface PriceSource {
  readonly id: PriceSourceId;
  /** Native resolution in seconds. Pyth publishes sub-second; exchange
   *  candles are minute-grained, and a sample from a 60s bucket cannot be
   *  held to a 2s tolerance. */
  readonly granularitySec: number;
  /** Human-readable note for sources with known coverage limits. */
  readonly note?: string;
  priceAt(feedKey: string, unixTime: number): Promise<PricePoint | null>;
}

/** Anything that can answer "what was this worth at time T". Both a single
 *  source and a consensus of several satisfy it, so the valuation layer does
 *  not need to know which it is holding. */
export interface PriceOracle {
  getPriceWindow(
    feedKey: string,
    targetTime: number,
    maxSkewSec?: number,
  ): Promise<PriceWindow | null>;
}

/**
 * A price source failed in a way that says nothing about the claim.
 *
 * This is deliberately distinct from "the source has no data for this feed".
 * A 429 or a socket reset must produce an `indeterminate` verdict and a
 * retry — never a rejection. Rejecting a valid claim because Hermes was
 * rate-limited is the exact failure mode this class exists to prevent.
 */
export class PriceSourceUnavailableError extends Error {
  readonly source: PriceSourceId;
  readonly retryAfterSec: number;
  readonly status?: number;

  constructor(
    source: PriceSourceId,
    message: string,
    options: { retryAfterSec?: number; status?: number } = {},
  ) {
    super(message);
    this.name = 'PriceSourceUnavailableError';
    this.source = source;
    this.retryAfterSec = options.retryAfterSec ?? 60;
    this.status = options.status;
  }
}

/** True when `err` should route the claim to the indeterminate lane. */
export function isSourceUnavailable(err: unknown): err is PriceSourceUnavailableError {
  return err instanceof PriceSourceUnavailableError;
}

/** Where in the pipeline a bundle was assembled. */
export type EvidenceStage = 'verify' | 'replay';


/**
 * Everything the adjudicator is allowed to look at, and nothing else.
 *
 * Grows across phases: Phase 1 fills identity + prices, Phase 2 adds
 * `execution`, Phase 3 widens `prices` to a multi-source consensus, Phase 4
 * adds `signatures`. Fields are optional so an older bundle stays replayable
 * against a newer adjudicator — the adjudicator must degrade to
 * `indeterminate` on missing inputs rather than guess.
 */
export interface EvidenceBundle {
  /** Bundle schema version. Bump on any shape change. */
  version: string;
  stage: EvidenceStage;

  triggerType: number;
  txSignature: string;
  agentAddress: string;
  coverageRaw: number;

  /** Slot of the trigger transaction, when resolvable. */
  slot: number | null;
  /** Block time of the trigger transaction, unix seconds. */
  blockTime: number | null;
  /** Set when Helius and the RPC disagreed about the block time. */
  blockTimeDisagreementSec?: number;

  /** Every price observation consulted, from every source. */
  prices: PricePoint[];
  /** The bracketing windows, keyed by `${source}:${feedId}`. */
  windows: Record<string, PriceWindow>;

  /** The agent's net position change, reconstructed from balance deltas. */
  execution?: ExecutionSummary;
  /** What each side of the trade was worth at the block time, per leg.
   *  Part of the evidence rather than the verdict: replaying a bundle must
   *  not require re-fetching prices, which would make the replay depend on
   *  sources still being up and still agreeing. */
  valuation?: { sold: LegValuation[]; bought: LegValuation[] };
  /** Structural evidence separating an attack from a bad trade. */
  signatures?: SignatureReport;

  /**
   * Wall-clock capture time. **Excluded from the bundle hash** — it is
   * provenance, not evidence, and including it would make every replay
   * produce a different hash.
   */
  collectedAt: number;
}
