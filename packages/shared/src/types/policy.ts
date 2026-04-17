/** Policy states matching on-chain enum. Must stay in sync with
 *  `InsurancePolicy::STATE_*` constants in the Anchor program. */
export enum PolicyState {
  Active = 0,
  ClaimPending = 1,
  ClaimPaid = 2,
  Expired = 3,
  Cancelled = 4,
}

/** Risk tier levels */
export enum RiskTier {
  LOW = 0,
  MEDIUM = 1,
  HIGH = 2,
  EXTREME = 3,
}

/** Trigger types for insurance claims */
export enum TriggerType {
  None = 0,
  Exploit = 1,
  OracleManipulation = 2,
  AgentError = 3,
  GovernanceAttack = 4,
}

/** Insurance policy representation */
export interface Policy {
  policyId: number;
  holder: string;
  agentAddress: string;
  coverageAmount: number;
  premiumPaid: number;
  riskTier: RiskTier;
  startTime: Date;
  expiryTime: Date;
  claimSubmittedAt: Date | null;
  state: PolicyState;
  triggerType: TriggerType;
  triggerTxSignature: string | null;
  payoutAmount: number;
  pdaAddress: string;
  createTxSignature: string | null;
}

/** Policy creation parameters */
export interface CreatePolicyParams {
  coverageAmount: number;
  durationSeconds: number;
  riskTier: RiskTier;
  agentAddress: string;
}

/**
 * Premium quote returned by `POST /api/policies/quote`.
 *
 * `riskTier` is derived server-side from the latest stored risk assessment —
 * the client cannot choose it. `validUntil` marks when the underlying
 * assessment becomes too stale to keep pricing against; clients must prompt
 * the user to re-assess past that point.
 */
export interface PremiumQuote {
  agentAddress: string;
  coverageAmount: number;
  durationSeconds: number;
  riskTier: RiskTier;
  premiumAmount: number;
  premiumBps: number;
  premiumMultiplier: number;
  assessmentId: string;
  assessedAt: string;
  validUntil: string;
  /**
   * On-chain RiskAttestation PDA (base58). Must be passed as an account
   * when calling the `create_policy` instruction. May be `null` if the
   * server could not publish an attestation (e.g. oracle wallet empty) —
   * clients should surface an error rather than attempt the purchase.
   */
  attestationPda: string | null;
  /** When the on-chain attestation expires (ISO-8601). */
  attestationExpiresAt: string | null;
}

/** Error codes returned by the quote endpoint when a quote cannot be issued. */
export type QuoteErrorCode =
  | 'ASSESSMENT_REQUIRED'
  | 'AGENT_UNINSURABLE'
  | 'ASSESSMENT_STALE'
  | 'ATTESTATION_PUBLISH_FAILED';
