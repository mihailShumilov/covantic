import type { TriggerType } from './policy.js';

/** Claim verification status */
export enum ClaimStatus {
  Pending = 'pending',
  Verifying = 'verifying',
  Approved = 'approved',
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
export const OPEN_CLAIM_STATUSES: readonly ClaimStatus[] = [
  ClaimStatus.Pending,
  ClaimStatus.Verifying,
  ClaimStatus.Approved,
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
