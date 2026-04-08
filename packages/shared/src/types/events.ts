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

/** Monitoring event types */
export enum MonitoringEventType {
  BalanceDrop = 'balance_drop',
  OracleDeviation = 'oracle_deviation',
  LargeTransfer = 'large_transfer',
  FailedTx = 'failed_tx',
  GovernanceChange = 'governance_change',
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
