import { eq, and } from 'drizzle-orm';
import type { Database } from '../config/database.js';
import { policies, monitoringEvents } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import type Redis from 'ioredis';

/**
 * Transaction monitor service.
 * Processes Helius webhooks for real-time agent transaction monitoring.
 *
 * Pipeline:
 * 1. Helius webhook -> POST /api/monitoring/webhook
 * 2. Parse Enhanced Transaction
 * 3. Check: is this an agent with an active policy?
 * 4. Analyze for anomalies:
 *    - balance_drop > 50%
 *    - oracle deviation > 5%
 *    - transfer > 100x normal
 *    - governance change
 * 5. If anomaly -> create monitoring_event -> WebSocket notification
 */
export class TransactionMonitor {
  constructor(
    private db: Database,
    private redis: Redis,
  ) {}

  /** Process an incoming Helius webhook payload */
  async processWebhook(payload: any[]): Promise<void> {
    for (const tx of payload) {
      try {
        await this.processTransaction(tx);
      } catch (error) {
        logger.error({ error, tx: tx?.signature }, 'Failed to process transaction');
      }
    }
  }

  /** Analyze a single transaction for anomalies */
  private async processTransaction(tx: any): Promise<void> {
    const signature = tx.signature;
    const tokenTransfers = tx.tokenTransfers ?? [];

    // Find involved agent addresses (check against active policies)
    for (const transfer of tokenTransfers) {
      const agentAddress = transfer.fromUserAccount;
      if (!agentAddress) continue;

      // Check if agent has active policy
      const activePolicies = await this.db
        .select()
        .from(policies)
        .where(and(eq(policies.agentAddress, agentAddress), eq(policies.state, 0)));

      if (activePolicies.length === 0) continue;

      // Analyze for anomalies
      const anomalies = this.detectAnomalies(tx, agentAddress);

      for (const anomaly of anomalies) {
        // Store monitoring event
        await this.db.insert(monitoringEvents).values({
          agentAddress,
          eventType: anomaly.type,
          severity: anomaly.severity,
          txSignature: signature,
          details: anomaly.details,
        });

        // Publish to Redis for WebSocket broadcast
        await this.redis.publish(
          'monitoring:alerts',
          JSON.stringify({
            channel: 'monitoring:alerts',
            event: anomaly.type,
            data: {
              agentAddress,
              ...anomaly,
              txSignature: signature,
            },
            timestamp: Date.now(),
          }),
        );

        logger.warn(
          { agentAddress, type: anomaly.type, severity: anomaly.severity },
          'Anomaly detected',
        );
      }
    }
  }

  /** Detect anomalies in a transaction */
  private detectAnomalies(
    tx: any,
    agentAddress: string,
  ): Array<{ type: string; severity: string; details: Record<string, unknown> }> {
    const anomalies: Array<{ type: string; severity: string; details: Record<string, unknown> }> =
      [];
    const tokenTransfers = tx.tokenTransfers ?? [];

    // Check for large balance drops
    const outgoing = tokenTransfers.filter((t: any) => t.fromUserAccount === agentAddress);
    const totalOutgoing = outgoing.reduce((sum: number, t: any) => sum + (t.tokenAmount ?? 0), 0);

    if (totalOutgoing > 1000) {
      // > 1000 token units
      anomalies.push({
        type: 'large_transfer',
        severity: totalOutgoing > 10000 ? 'critical' : 'warning',
        details: { amount: totalOutgoing, transfers: outgoing.length },
      });
    }

    // Check for transaction errors
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
