import { TriggerType } from './policy.js';

/** Claim verification status */
export enum ClaimStatus {
  Pending = 'pending',
  Verifying = 'verifying',
  Approved = 'approved',
  /** The payout transaction is in flight. Written by the keeper before the
   *  on-chain call so a retry after an RPC success does not send it twice.
   *  It was already being written and already in the `claims_open_unique`
   *  predicate; it just was not declared here. */
  Paying = 'paying',
  Paid = 'paid',
  Rejected = 'rejected',
  /** Payout attempt failed (e.g. insufficient vault balance, RPC error). */
  Failed = 'failed',
  /** Verification could not reach a conclusion — a price source was
   *  unavailable, references disagreed, or the trigger tx was not yet
   *  indexed. The claim is retried with backoff; it is NEVER auto-rejected,
   *  because "we could not check" is not "there was no loss". */
  Indeterminate = 'indeterminate',
  /** Escalated to a human/committee adjuster after repeated indeterminate
   *  verification, or because the evidence supports a loss but not strongly
   *  enough for the auto-pay lane. */
  Review = 'review',
}

/** Claim statuses that count as "open" — a policy may hold at most one
 *  claim in any of these states (enforced by the `claims_open_unique`
 *  partial index in db/custom-constraints.ts). Keep the two in sync. */
/**
 * How specific a trigger's account of an incident is.
 *
 * Mirrors `ANOMALY_SPECIFICITY` in the monitor, at the trigger level, and
 * exists for one job: deciding whether a newly detected threat deserves the
 * policy's single open-claim slot more than whatever is parked in it.
 *
 * Higher wins. A takeover outranks a drain for the reason the monitor's table
 * gives — the governance verifier can speak to who owns the account now, and
 * the exploit verifier cannot.
 */
export const TRIGGER_SPECIFICITY: Record<TriggerType, number> = {
  // Never supersedes anything; it is the absence of a trigger.
  [TriggerType.None]: 0,
  [TriggerType.GovernanceAttack]: 5,
  [TriggerType.Exploit]: 4,
  [TriggerType.OracleManipulation]: 3,
  [TriggerType.AgentError]: 2,
};

/**
 * Open statuses in which nothing automated is still working on the claim.
 *
 * These hold the policy's slot without progressing, which is what made them a
 * denial-of-coverage vector: park a cheap `indeterminate` on a policy and
 * every later alert for it — including a genuine exploit — was dropped at the
 * unique index. A claim in one of these may be re-pointed at a
 * higher-specificity trigger; one in `verifying`, `approved` or `paying` may
 * not, because a job or an on-chain transaction is mid-flight.
 */
export const PARKED_CLAIM_STATUSES: readonly ClaimStatus[] = [
  ClaimStatus.Indeterminate,
  ClaimStatus.Review,
] as const;

/**
 * Park reasons that no retry can clear.
 *
 * Each one means the *holder's declaration* cannot support this claim, and
 * that fact is fixed: the two `no_*` reasons say no declaration exists, and
 * the two `*_not_matured` ones compare a declaration's `effective_at` against
 * the incident's block time — both already in the past, so waiting changes
 * nothing.
 *
 * They matter because of what they collide with. The most ordinary real theft
 * is a phished `Approve` followed by a drain, and the approval is a change of
 * control, so a governance claim opens first and parks here for want of a
 * baseline. Ranked by specificity alone the drain's exploit claim can never
 * take the slot — governance outranks it — so the protocol would file the
 * claim it cannot prove and block the one it can. That is the
 * denial-of-coverage shape {@link PARKED_CLAIM_STATUSES} was written against,
 * arriving by a route the ordering did not anticipate.
 *
 * Deliberately excludes `baseline_lookup_unavailable` and
 * `mandate_lookup_unavailable`: those are outages, they do clear on retry, and
 * treating a temporarily blind verifier as permanently stuck would hand the
 * slot away for no reason.
 */
export const UNRESOLVABLE_PARK_REASONS: readonly string[] = [
  'no_governance_baseline',
  'no_mandate_declared',
  'governance_baseline_not_matured',
  'mandate_not_matured',
  // Not a declaration problem, the same dead end by another route: a claim
  // that cannot locate its own trigger transaction has nothing to adjudicate,
  // and the keeper only settles on this after exhausting its retries. Holding
  // the slot on it keeps a policy deaf for no benefit.
  'trigger_tx_not_found',
] as const;

/**
 * Park reasons that describe *this transaction*, not this policy.
 *
 * The distinction decides whether an equally specific repeat may take the
 * slot. Every other reason in `UNRESOLVABLE_PARK_REASONS` is a standing fact
 * about the policy — no mandate declared, a baseline not matured — so a second
 * alert of the same trigger says nothing new and the tie rule correctly
 * refuses it, or a stream of identical alerts would reset the claim forever.
 *
 * `trigger_tx_not_found` is not that. It is per-transaction and it is usually
 * infrastructure: an indexer that lagged, an endpoint that would not answer. A
 * later alert naming a *different* signature is genuinely new information, and
 * refusing it let one outage deafen a policy for that trigger permanently —
 * which is what happened when a vendor's quota ran out and every claim of
 * every type parked here.
 */
export const TRANSIENT_PARK_REASONS: readonly string[] = ['trigger_tx_not_found'] as const;

/** True when the parked claim's dead end was about its transaction rather
 *  than about the policy, so a different transaction deserves another look. */
export function isTransientlyParked(reviewReason: string | null | undefined): boolean {
  return reviewReason !== null && reviewReason !== undefined
    ? TRANSIENT_PARK_REASONS.includes(reviewReason)
    : false;
}

/** True when a parked claim is waiting on a declaration that cannot arrive in
 *  time for it, and should therefore yield the policy's slot to any claim
 *  that can actually be adjudicated. */
export function isPermanentlyParked(reviewReason: string | null | undefined): boolean {
  return reviewReason !== null && reviewReason !== undefined
    ? UNRESOLVABLE_PARK_REASONS.includes(reviewReason)
    : false;
}

export const OPEN_CLAIM_STATUSES: readonly ClaimStatus[] = [
  ClaimStatus.Pending,
  ClaimStatus.Verifying,
  ClaimStatus.Approved,
  ClaimStatus.Paying,
  ClaimStatus.Indeterminate,
  ClaimStatus.Review,
] as const;

/** Insurance claim */
export interface Claim {
  id: string;
  policyId: number;
  holderAddress: string;
  agentAddress: string;
  triggerType: TriggerType;
  triggerTxSignature: string;
  lossAmount: number | null;
  payoutAmount: number | null;
  verificationData: Record<string, unknown> | null;
  status: ClaimStatus;
  verifiedAt: Date | null;
  paidAt: Date | null;
  /** On-chain tx signature for the oracle's oracle_submit_claim call. */
  submitTxSignature: string | null;
  /** On-chain tx signature for verify_and_payout (USDC transfer to holder). */
  payoutTxSignature: string | null;
  lockExpiresAt: Date | null;
  createdAt: Date;
}

/** Claim submission parameters */
export interface SubmitClaimParams {
  policyId: number;
  triggerType: TriggerType;
  triggerTxSignature: string;
}

/** Claim verification pipeline step */
export enum VerificationStep {
  PolicyCheck = 'policy_check',
  TriggerDetection = 'trigger_detection',
  LossCalculation = 'loss_calculation',
  OracleConfirmation = 'oracle_confirmation',
  PayoutExecution = 'payout_execution',
}

/** Status for each verification step */
export enum StepStatus {
  Pending = 'pending',
  Processing = 'processing',
  Success = 'success',
  Failed = 'failed',
}

/** Pipeline step state */
export interface PipelineStep {
  step: VerificationStep;
  status: StepStatus;
  message?: string;
  data?: Record<string, unknown>;
}

/** JSON shape persisted in the `claims.verification_data` column. All
 *  fields optional — accumulated across the ingest / verify / payout
 *  stages. Consumers should treat every field as possibly missing. */
export interface VerificationData {
  /** Event name from the monitoring bus that triggered the claim */
  eventType?: string;
  /** Origin of the entry (`claim-keeper`, `indexer`, etc.) */
  source?: string;
  /** True when the claim came from a demo / simulation path */
  simulated?: boolean;
  /** Verifier output merged on the verify step */
  confidence?: number;
  method?: string;
  txSignature?: string;
  /** Reason when the claim is rejected */
  reason?: string;
  /** Structured details from the rejection path */
  details?: Record<string, unknown>;
  /** Stringified error from a failed payout attempt */
  payoutError?: string;
  /** Terminal verdict from the verifier: confirmed | rejected | indeterminate */
  outcome?: string;
  /** sha256 of the canonical evidence bundle the verdict was derived from */
  bundleHash?: string;
  /** Number of verification attempts made so far (indeterminate retries) */
  verifyAttempts?: number;
  /** Open-ended overflow for verifier-specific fields */
  [key: string]: unknown;
}
