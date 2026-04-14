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
}

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
