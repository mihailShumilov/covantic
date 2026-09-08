import type { Claim } from './claims.js';
import type { Policy } from './policy.js';
import type { VaultStats } from './vault.js';

/** WebSocket message format */
export interface WSMessage<T = unknown> {
  channel: string;
  event: string;
  data: T;
  timestamp: number;
}

/** WebSocket channel names */
export enum WSChannel {
  ClaimsFeed = 'claims:feed',
  VaultStats = 'vault:stats',
  MonitoringAlerts = 'monitoring:alerts',
}

/** Agent-specific channel: `agent:{address}:events` */
export function agentChannel(address: string): string {
  return `agent:${address}:events`;
}

/** Claims feed events */
export enum ClaimEvent {
  NewClaim = 'new_claim',
  ClaimUpdated = 'claim_updated',
  ClaimPaid = 'claim_paid',
}

/**
 * Which declared bound an agent-error payout rested on.
 *
 * Carried as a `u8` by the on-chain `AgentErrorProofVerified` event and the
 * `AgentErrorEvidenceRecord` account. Must stay in sync with
 * `BREACH_OUTFLOW_CAP` / `BREACH_RETAINED_FLOOR` in the program's
 * `constants.rs`; an indexer must not have to read a private instruction
 * module to decode the value, and must not fold an unknown value into one of
 * these — see {@link breachKindFromChain}.
 */
export enum AgentErrorBreachKind {
  /** The measured drop exceeded the declared single-outflow cap. */
  OutflowCap = 1,
  /** The account ended below the declared retention floor. */
  RetainedFloor = 2,
}

/** Decode an on-chain `breach_kind`, refusing to guess at a value the
 *  vocabulary does not name. */
export function breachKindFromChain(value: number): AgentErrorBreachKind | null {
  switch (value) {
    case AgentErrorBreachKind.OutflowCap:
      return AgentErrorBreachKind.OutflowCap;
    case AgentErrorBreachKind.RetainedFloor:
      return AgentErrorBreachKind.RetainedFloor;
    default:
      return null;
  }
}

/**
 * Which on-chain proof a paid claim was settled through.
 *
 * Derived from the *evidence account* the settlement instruction created —
 * `ClaimEvidenceRecord`, `ExploitEvidenceRecord`, `GovernanceEvidenceRecord`
 * or `AgentErrorEvidenceRecord` — never from transaction logs. Logs are
 * emitted by whichever program ran in the transaction, so a proof event next
 * to a `ClaimPaid` proves nothing about who emitted it, and a truncated log
 * hides a proof that did run. An account owned by the program at the seed the
 * program derives is the one artefact nobody else can write.
 *
 * `unproven` exists for policies paid before the unverified instruction was
 * removed from the program: they are `ClaimPaid` with no evidence account,
 * and an indexer must say so rather than present them as chain-checked.
 */
export enum ProofKind {
  Price = 'price',
  Balance = 'balance',
  Authority = 'authority',
  Mandate = 'mandate',
  Unproven = 'unproven',
}

/** Vault stats events */
export enum VaultEvent {
  StatsUpdated = 'stats_updated',
  SolvencyChanged = 'solvency_changed',
}

/**
 * The complete vocabulary of monitoring event types.
 *
 * This enum is the contract between the detectors that raise events and the
 * claim keeper's `EVENT_TO_TRIGGER` map, and it is enforced as one:
 * `tests/monitoring-vocabulary.test.ts` fails the build if any value here is
 * missing from that map. Producers must use these members rather than string
 * literals — literals are how the two drifted apart in the first place.
 *
 * What that drift cost: this enum declared `GovernanceChange = 'governance_change'`
 * while the keeper mapped `'governance_attack'`. Anything raised under the
 * enum's spelling would have been silently dropped as an unhandled event
 * type, with a debug log as the only trace.
 */
export enum MonitoringEventType {
  /** Funds left the agent under an authority that was not the agent's. */
  Exploit = 'exploit',
  /** A fill sat far enough from the reference price to look manipulated. */
  OracleDeviation = 'oracle_deviation',
  /** The agent did something costly to itself. */
  AgentError = 'agent_error',
  /** Control over the agent's accounts or program left the holder's set. */
  GovernanceAttack = 'governance_attack',
  LargeTransfer = 'large_transfer',
  FailedTx = 'failed_tx',
  /**
   * Balances fell with no transaction the screen could attribute it to.
   * Deliberately maps to no trigger: there is nothing for a verifier to
   * verify, so it goes to a human rather than opening a claim.
   */
  BalanceDropUnexplained = 'balance_drop_unexplained',
}

/** Monitoring event severity */
export enum MonitoringSeverity {
  Info = 'info',
  Warning = 'warning',
  Critical = 'critical',
}

/** Monitoring event */
export interface MonitoringEvent {
  id: string;
  agentAddress: string;
  eventType: MonitoringEventType;
  severity: MonitoringSeverity;
  txSignature: string | null;
  details: Record<string, unknown> | null;
  processed: boolean;
  createdAt: Date;
}

/** WebSocket event payloads */
export type ClaimFeedPayload = WSMessage<Claim>;
export type VaultStatsPayload = WSMessage<VaultStats>;
export type MonitoringAlertPayload = WSMessage<MonitoringEvent>;
export type PolicyEventPayload = WSMessage<Policy>;
