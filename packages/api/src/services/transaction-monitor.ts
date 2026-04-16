import { and, eq, inArray } from 'drizzle-orm';
import { PolicyState } from '@covantic/shared';
import type { Database } from '../config/database.js';
import { policies, monitoringEvents } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import type Redis from 'ioredis';
import { publishAlert } from './alert-bus.js';

/** Anomaly detection thresholds (USDC token units, 6 decimals) */
const LARGE_TRANSFER_THRESHOLD = 1000_000_000; // 1,000 USDC — triggers warning
const CRITICAL_TRANSFER_THRESHOLD = 10_000_000_000; // 10,000 USDC — triggers critical

/** Minimal shape we read from the Helius enhanced transaction envelope. */
interface WebhookTransaction {
  signature?: string;
  transactionError?: unknown;
  tokenTransfers?: Array<{ fromUserAccount?: string; tokenAmount?: number }>;
}

/**
 * Transaction monitor service.
 * Processes Helius webhooks for real-time agent transaction monitoring.
 *
 * Alerts are fanned out on the internal signed alert bus
 * ({@link publishAlert}) so the claim-keeper (and only processes holding
 * ALERT_HMAC_SECRET) can act on them.
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
    if (addresses.length === 0) return;

    const insuredRows = await this.db
      .select({ agentAddress: policies.agentAddress })
      .from(policies)
      .where(
        and(
          inArray(policies.agentAddress, addresses),
          eq(policies.state, PolicyState.Active),
        ),
      );
    const insuredActive = new Set(insuredRows.map((r) => r.agentAddress));
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

        logger.warn(
          { agentAddress, type: anomaly.type, severity: anomaly.severity },
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
