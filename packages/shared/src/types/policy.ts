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

/** Premium quote from the API */
export interface PremiumQuote {
  coverageAmount: number;
  durationSeconds: number;
  riskTier: RiskTier;
  premiumAmount: number;
  premiumBps: number;
  premiumMultiplier: number;
}
