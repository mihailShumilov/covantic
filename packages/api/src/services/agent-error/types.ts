import type { EvidenceStage, PricePoint, PriceWindow } from '../oracle/types.js';
import type { AuthorizationReport } from '../exploit/authorization.js';
import type { LossAssessment } from '../exploit/loss.js';
import type { PositionDelta } from '../exploit/position.js';
import type { MandateBreachReport } from './breach.js';

/**
 * The operating envelope the holder declared, as read from chain.
 *
 * This is the thing that makes an agent-error verdict possible at all, and it
 * is worth being precise about why. An exploit verdict can *infer* whether the
 * agent consented, because an unauthorised signer leaves a trace. A governance
 * verdict can *test* consent, because the holder declared who may hold control.
 * Neither helps here: an agent error is a loss the agent caused with its own
 * authority, so every trace says the agent meant it, and the only thing that
 * separates a mistake from a decision is what the holder expected — which is
 * not a fact on chain unless they put it there first.
 *
 * `null` for the whole record means no declaration exists. That is a gap in our
 * records, **not permission**, and the adjudicator treats it as `indeterminate`
 * rather than reading it either way.
 */
export interface MandateView {
  /** Largest single outflow permitted, raw base units of the covered mint. */
  maxSingleOutflowRaw: number;
  /** Largest cumulative outflow permitted over `windowSeconds`. */
  maxWindowOutflowRaw: number;
  windowSeconds: number;
  /** Balance the agent must never take the covered account below. */
  minRetainedBalanceRaw: number;
  /**
   * Destinations the holder permitted.
   *
   * An **empty list means "not declared"**, never "nothing is permitted". A
   * holder who left this blank has said nothing about destinations, and
   * treating silence as a universal prohibition would make every ordinary
   * transfer a breach — the exact failure mode the old program-membership
   * verifier had, arrived at from the opposite direction.
   */
  allowedCounterparties: string[];
  /** Programs the holder permitted. Same "empty means undeclared" rule. */
  allowedPrograms: string[];
  /** sha256 of the off-chain manifest the on-chain record commits to. */
  manifestHash: string;
  declaredAt: number;
  /** When the declaration became usable as proof. */
  effectiveAt: number;
  /**
   * The declaration matured *before* the claim it is being used to judge.
   *
   * Without this a holder could watch an ordinary loss happen and then declare,
   * retroactively, an envelope narrow enough to have been breached by it. The
   * delay is what forces that manoeuvre to be pre-committed on chain, in
   * public, an hour ahead.
   */
  maturedBeforeClaim: boolean;
}

/** What the agent's own spending normally looks like, for context. */
export interface OutflowBaselineView {
  /** Rolling window the statistics were computed over, seconds. */
  windowSeconds: number;
  transferCount: number;
  meanOutflowRaw: number;
  medianOutflowRaw: number;
  p95OutflowRaw: number;
  /** Cumulative outflow inside the mandate window ending at the trigger. */
  windowOutflowRaw: number;
  /** Unix seconds of the oldest observation. */
  observedFrom: number;
  /** Unix seconds the statistics were computed at. */
  computedAt: number;
  /** Past this the history describes a different week; the ratio it supports
   *  is reported as unevaluated rather than merely old. */
  stale: boolean;
}

/**
 * Everything an agent-error verdict is allowed to rest on, and nothing else.
 *
 * Same contract as the other three bundles, for the same reason: **all network
 * I/O happens while building this; the adjudication that reads it is a pure
 * function.** A payout nobody can re-derive is a payout nobody can audit, and
 * this trigger had no bundle at all before — an agent-error payout was not
 * reproducible even in principle.
 *
 * Fields are optional so an older bundle stays replayable against a newer
 * adjudicator. The adjudicator must degrade to `indeterminate` on missing
 * inputs rather than guess.
 */
export interface AgentErrorEvidenceBundle {
  /** Bundle schema version. Bump on any shape change. */
  version: string;
  stage: EvidenceStage;

  /** Always {@link TriggerType.AgentError}. Carried so a replay can dispatch
   *  to the right adjudicator without consulting the claim row. */
  triggerType: number;
  txSignature: string;
  agentAddress: string;
  holderAddress?: string;
  coverageRaw: number;
  /** Mint the mandate's amounts are denominated in. */
  coveredMint?: string;

  slot: number | null;
  blockTime: number | null;
  /** Set when the indexer and the RPC disagreed about the block time. */
  blockTimeDisagreementSec?: number;

  /** Whether the chain's own record was available. Signer flags and per-side
   *  token account owners live only there, and the decisive question on this
   *  trigger — did the agent's *own* authority move the money — is answerable
   *  from nowhere else. */
  hasRawTx: boolean;

  /**
   * The declared envelope. `undefined` means the lookup never ran; `null`
   * means it ran and found no declaration. The adjudicator distinguishes them
   * because one is an outage and the other is a policy that predates the
   * mechanism.
   */
  mandate?: MandateView | null;

  /** What moved, across everything the agent controlled. */
  position?: PositionDelta;
  /** What it was worth at the block time. */
  loss?: LossAssessment;
  /** Who authorised it. On this trigger the answer must be "the agent". */
  authorization?: AuthorizationReport;
  /** Where the movement fell against the declared envelope. */
  breach?: MandateBreachReport;
  /** How this compares with the agent's own spending history. Context and a
   *  confidence input, never a verdict input on its own: "unusual for this
   *  agent" is a reason to look, not a reason to pay. */
  outflowBaseline?: OutflowBaselineView | null;
  /** Programs invoked, for the audit trail. Not a verdict input — building a
   *  verdict out of this field is what the retired verifier did. */
  programs?: Record<string, unknown>;

  /** Price observations consulted while valuing the movement, and the
   *  bracketing windows they came from. Kept so a replay re-derives the
   *  valuation without re-fetching. */
  prices: PricePoint[];
  windows: Record<string, PriceWindow>;

  /**
   * Wall-clock capture time. **Excluded from the bundle hash** — provenance,
   * not evidence, and including it would make every replay hash differently.
   */
  collectedAt: number;
}

/** Bump on any change to the bundle's shape. */
export const AGENT_ERROR_BUNDLE_VERSION = '1.0.0';
