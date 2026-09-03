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
   * What the envelope costs on top of the tier. Always zero now.
   *
   * It used to be the amount the holder could move past their own declared
   * cap, charged flat — the only honest price while the holder chose the cap,
   * and the reason a policy could cost more than the cover it bought. The
   * envelope is derived from the agent's record instead, and an agent-error
   * payout cannot exceed the premium, so there is no extraction capacity left
   * to charge for. Kept in the response because the program still reads the
   * field from the attestation, and a silent zero is worse than a stated one.
   */
  envelopeFlatPremium: number;
  /**
   * The most cover worth buying on this agent, in base units.
   *
   * The tighter of two bounds: what the agent holds — cover above it pays for
   * a loss that cannot happen — and what the vault's stake supports, since
   * `create_policy` refuses below half of coverage staked. Both are knowable
   * at the quote, where the buyer can still change the number, rather than at
   * the purchase, where they are a failed transaction.
   */
  maxCoverage: number;
  /** Which of the two bounds is the binding one, so the form can say why. */
  maxCoverageBound: 'agent_balance' | 'vault_capacity';
  /** What the agent holds now, in base units — the figure the bound above is
   *  derived from, so the buyer can check the reasoning. */
  agentCoveredBalance: number;
  /**
   * The operating envelope this policy will be bought against.
   *
   * Derived, not chosen: a holder who picks the cap picks the breach. The
   * oracle commits to this exact shape in the attestation it signs, so the
   * client must pass it back unchanged — `create_policy` compares the two and
   * refuses anything else.
   */
  mandate: {
    maxSingleOutflowRaw: number;
    maxWindowOutflowRaw: number;
    windowSeconds: number;
    minRetainedBalanceRaw: number;
    allowedCounterparties: string[];
    allowedPrograms: string[];
  };
  /** `history` when the cap came from what the agent does, `balance` when
   *  there was not enough of it and the cap is the balance itself. */
  envelopeBasis: 'history' | 'balance';
  /** The ordinary movement the cap was drawn from, base units, or null on the
   *  balance basis. */
  ordinaryOutflow: number | null;
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
