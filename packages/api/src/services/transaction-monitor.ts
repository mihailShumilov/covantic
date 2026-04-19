import { inArray } from 'drizzle-orm';
import { PolicyState } from '@covantic/shared';
import type { Database } from '../config/database.js';
import { policies, monitoringEvents } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import type Redis from 'ioredis';
import { publishAlert } from './alert-bus.js';
import { incrementMetric } from '../utils/monitor-metrics.js';

/** Anomaly detection thresholds (USDC token units, 6 decimals) */
const LARGE_TRANSFER_THRESHOLD = 1000_000_000; // 1,000 USDC — triggers warning
const CRITICAL_TRANSFER_THRESHOLD = 10_000_000_000; // 10,000 USDC — triggers critical

/** Minimal shape we read from the Helius enhanced transaction envelope. */
interface WebhookTransaction {
  signature?: string;
  transactionError?: unknown;
  tokenTransfers?: Array<{ fromUserAccount?: string; tokenAmount?: number }>;
}

interface PolicyLookupRow {
  agentAddress: string;
  policyId: number;
  state: number;
}

/**
 * Transaction monitor service.
 * Processes Helius webhooks for real-time agent transaction monitoring.
 *
 * Alerts are fanned out on the internal signed alert bus
 * ({@link publishAlert}) so the claim-keeper (and only processes holding
 * ALERT_HMAC_SECRET) can act on them.
 *
 * Observability: every decision (match, skip-uninsured, skip-inactive) is
 * counted via {@link incrementMetric} and the inactive-policy case is logged
 * at `info` — it's the single most useful breadcrumb when debugging
 * "webhook fired but nothing happened".
 */
export class TransactionMonitor {
  constructor(
    private db: Database,
    private redis: Redis,
    private alertSecret: string,
  ) {}

  async processWebhook(payload: WebhookTransaction[]): Promise<void> {
    for (const tx of payload) {
      try {
        await this.processTransaction(tx);
      } catch (error) {
        await incrementMetric(this.redis, 'error:tx');
        logger.error({ error, tx: tx?.signature }, 'Failed to process transaction');
      }
    }
  }

  private async processTransaction(tx: WebhookTransaction): Promise<void> {
    const signature = tx.signature;
    const tokenTransfers = tx.tokenTransfers ?? [];

    // Collect distinct agent addresses so we hit the DB once, not N times.
    const addresses = Array.from(
      new Set(
        tokenTransfers
          .map((t) => t.fromUserAccount)
          .filter((a): a is string => typeof a === 'string' && a.length > 0),
      ),
    );
    if (addresses.length === 0) {
      await incrementMetric(this.redis, 'skipped:no_addresses');
      return;
    }

    // Fetch ALL policies for these addresses (not just Active) so we can
    // tell "no policy at all" apart from "policy exists but state != Active".
    // The latter is the interesting signal when debugging why a tx didn't
    // produce an alert — it's the difference between "agent uninsured" and
    // "coverage expired / claim already filed".
    const insuredRows: PolicyLookupRow[] = await this.db
      .select({
        agentAddress: policies.agentAddress,
        policyId: policies.policyId,
        state: policies.state,
      })
      .from(policies)
      .where(inArray(policies.agentAddress, addresses));

    const byAddress = new Map<string, PolicyLookupRow[]>();
    for (const row of insuredRows) {
      const list = byAddress.get(row.agentAddress) ?? [];
      list.push(row);
      byAddress.set(row.agentAddress, list);
    }

    const insuredActive = new Set<string>();
    for (const addr of addresses) {
      const list = byAddress.get(addr) ?? [];
      if (list.length === 0) {
        await incrementMetric(this.redis, 'skipped:uninsured');
        continue;
      }
      const activePolicy = list.find((p) => p.state === PolicyState.Active);
      if (activePolicy) {
        insuredActive.add(addr);
        await incrementMetric(this.redis, 'matched:active');
      } else {
        await incrementMetric(this.redis, 'skipped:inactive_policy');
        logger.info(
          {
            agentAddress: addr,
            txSignature: signature,
            policies: list.map((p) => ({ policyId: p.policyId, state: p.state })),
          },
          'monitor: tx from agent with no Active policy — skipped',
        );
      }
    }

    if (insuredActive.size === 0) return;

    for (const transfer of tokenTransfers) {
      const agentAddress = transfer.fromUserAccount;
      if (!agentAddress || !insuredActive.has(agentAddress)) continue;

      const anomalies = this.detectAnomalies(tx, agentAddress);

      for (const anomaly of anomalies) {
        await this.db.insert(monitoringEvents).values({
          agentAddress,
          eventType: anomaly.type,
          severity: anomaly.severity,
          txSignature: signature,
          details: anomaly.details,
        });

        await publishAlert(this.redis, this.alertSecret, {
          channel: 'monitoring:alerts',
          event: anomaly.type,
          data: {
            agentAddress,
            ...anomaly,
            txSignature: signature,
          },
          timestamp: Date.now(),
        });

        await incrementMetric(
          this.redis,
          anomaly.severity === 'critical' ? 'anomaly:critical' : 'anomaly:warning',
        );

        logger.warn(
          { agentAddress, type: anomaly.type, severity: anomaly.severity, txSignature: signature },
          'Anomaly detected',
        );
      }
    }
  }

  private detectAnomalies(
    tx: WebhookTransaction,
    agentAddress: string,
  ): Array<{ type: string; severity: string; details: Record<string, unknown> }> {
    const anomalies: Array<{ type: string; severity: string; details: Record<string, unknown> }> =
      [];
    const tokenTransfers = tx.tokenTransfers ?? [];

    const outgoing = tokenTransfers.filter((t) => t.fromUserAccount === agentAddress);
    const totalOutgoing = outgoing.reduce((sum, t) => sum + (t.tokenAmount ?? 0), 0);

    if (totalOutgoing > LARGE_TRANSFER_THRESHOLD) {
      anomalies.push({
        type: 'large_transfer',
        severity: totalOutgoing > CRITICAL_TRANSFER_THRESHOLD ? 'critical' : 'warning',
        details: { amount: totalOutgoing, transfers: outgoing.length },
      });
    }

    if (tx.transactionError) {
      anomalies.push({
        type: 'failed_tx',
        severity: 'warning',
        details: { error: tx.transactionError },
      });
    }

    return anomalies;
  }
}
