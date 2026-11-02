/** The policy state a verdict depends on, read from Solana. */
export interface PolicySnapshot {
  address: string;
  policyId: string;
  holder: string;
  agent: string;
  coverageRaw: number;
  state: number;
  startTime: number;
  expiryTime: number;
  terms: PriceTerms | null;
}

export interface PriceTerms {
  feedIdHex: string;
  subjectMint: string;
  subjectDecimals: number;
  maxSubjectQuantity: bigint;
}

export const POLICY_STATE_ACTIVE = 0;

export interface PredicateInputs {
  payoutAmount: bigint;
  triggerBlockTime: number;
  executedPriceScaled: number;
  subjectQuantity: bigint;
  subjectDecimals: number;
  feedIdHex: string;
  signedUpdateHex: string;
}

export type PredicateResult =
  | {
      verdict: 'PAY';
      reason: string;
      policy: string;
      trigger_tx: string;
      evidence_hash: string;
      inputs: PredicateInputs;
    }
  | {
      verdict: 'NO_PAY';
      reason: string;
      policy: string;
      trigger_tx: string;
      evidence_hash: string | null;
      /** True when the same evidence could pay once a source recovers. */
      retryable: boolean;
      details: Record<string, unknown>;
    };
