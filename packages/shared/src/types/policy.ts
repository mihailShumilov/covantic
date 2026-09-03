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
  /**
   * What the declared envelope costs, as a flat amount in the covered mint's
   * base units. Not scaled by duration — see `calculatePremium`.
   *
   * Disclosed rather than folded silently into the total: the deductible is
   * the holder's own choice, and a price that moves with it should say so.
   * A holder who sees it can widen the envelope and requote.
   */
  envelopeFlatPremium: number;
  /**
   * The most this policy can ever pay, in base units.
   *
   * The same number as `envelopeFlatPremium` whenever the envelope is what
   * sets the price, and saying so is the point. A breach cannot overshoot the
   * declared cap by more than the agent holds above it, so what a holder could
   * take at will is both what they are charged and the ceiling on what they
   * can be paid. Disclosed at the quote because that is where the decision is,
   * rather than in the claim where it would be a surprise.
   */
  maxClaimable: number;
  /**
   * How much of the requested coverage no breach of this envelope can reach.
   *
   * Coverage above the agent's headroom over its own cap buys nothing: the
   * payout is the overshoot, and the overshoot is bounded by what the agent
   * holds. Non-zero here means the buyer is paying tier premium on cover that
   * cannot be claimed.
   */
  coverageBeyondEnvelope: number;
  /** What the agent holds now, in base units — the figure both of the above
   *  are derived from, so the buyer can check the reasoning. */
  agentCoveredBalance: number;
  /**
   * How far the declared cap sits above what the agent normally moves, or
   * null when there is no history to measure against — which is charged at
   * the ceiling, not refused.
   */
  envelopeHeadroom: number | null;
}

/** Error codes returned by the quote endpoint when a quote cannot be issued. */
export type QuoteErrorCode =
  | 'ASSESSMENT_REQUIRED'
  | 'AGENT_UNINSURABLE'
  | 'ASSESSMENT_STALE'
  | 'ATTESTATION_PUBLISH_FAILED'
  /** The declared envelope is tighter than the agent's ordinary activity, so
   *  a breach is scheduled rather than risked and no premium prices it. */
  | 'ENVELOPE_NOT_INSURABLE';
