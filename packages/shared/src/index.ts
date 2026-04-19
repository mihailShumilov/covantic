// Types
export type { Policy, CreatePolicyParams, PremiumQuote, QuoteErrorCode } from './types/policy.js';
export { PolicyState, RiskTier, TriggerType } from './types/policy.js';

export type { VaultStats, VaultSnapshot } from './types/vault.js';
export { SolvencyStatus } from './types/vault.js';

export type {
  RiskCategory,
  RiskFactors,
  FactorWeightInfo,
  FactorDetail,
  CategoryRisk,
  DataAvailability,
  RiskAssessment,
  Agent,
} from './types/risk.js';

export type {
  Claim,
  SubmitClaimParams,
  PipelineStep,
  VerificationData,
} from './types/claims.js';
export { ClaimStatus, VerificationStep, StepStatus } from './types/claims.js';

export type { StakerPositionResponse } from './types/staking.js';

export type {
  WSMessage,
  MonitoringEvent,
  ClaimFeedPayload,
  VaultStatsPayload,
  MonitoringAlertPayload,
  PolicyEventPayload,
} from './types/events.js';
export {
  WSChannel,
  ClaimEvent,
  VaultEvent,
  MonitoringEventType,
  MonitoringSeverity,
  agentChannel,
} from './types/events.js';

// Constants
export {
  USDC_DECIMALS,
  usdcToLamports,
  lamportsToUsdc,
  PDA_SEEDS,
  ATTESTATION_MAX_VALIDITY_SECONDS,
  COVERAGE,
  DURATION,
  PREMIUM_BPS,
  PREMIUM_SPLIT,
  SOLVENCY_THRESHOLDS,
  UNSTAKE_COOLDOWN,
  LOCK_PERIODS,
  MAX_POLICIES_PER_WALLET,
  RISK_SCORE_BOUNDARIES,
  SOLANA_ADDRESS_REGEX,
  SOLANA_SIGNATURE_REGEX,
  SPL_MEMO_PROGRAM_ID,
  MAX_TX_BYTES,
  SYNTHETIC_PAYOUT_RATIO,
  DEMO_TX_SIGNATURE_PREFIX,
  generateDemoTxSignature,
  policyIdToBytes,
} from './constants.js';

// Utils
export {
  calculatePremium,
  tierToPremiumBps,
  isInsurableTier,
  scoreToTier,
  TIER_LABELS,
  solvencyStatus,
  formatUsdc,
  formatDuration,
  isValidDuration,
  shortenAddress,
} from './utils.js';
