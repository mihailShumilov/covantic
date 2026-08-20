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
