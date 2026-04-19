import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  PolicyState,
  SOLANA_ADDRESS_REGEX,
  generateDemoTxSignature,
} from '@covantic/shared';
import { monitoringEvents, policies } from '../db/schema.js';
import { TransactionMonitor } from '../services/transaction-monitor.js';
import { publishAlert } from '../services/alert-bus.js';
import { readMonitorMetrics } from '../utils/monitor-metrics.js';

/** Stripped-down shape we require from the Helius enhanced-transaction
 *  payload. Everything else is ignored, including fields we'd otherwise
 *  trust for anomaly detection (processTransaction re-derives those). */
const tokenTransferSchema = z
  .object({
    fromUserAccount: z.string().optional(),
    toUserAccount: z.string().optional(),
    tokenAmount: z.number().optional(),
  })
  .passthrough();

const enhancedTransactionSchema = z
  .object({
    signature: z.string().optional(),
    transactionError: z.unknown().optional(),
    tokenTransfers: z.array(tokenTransferSchema).optional(),
    accountData: z.array(z.unknown()).optional(),
  })
  .passthrough();

const webhookPayloadSchema = z.union([
  z.array(enhancedTransactionSchema),
  enhancedTransactionSchema.transform((tx) => [tx]),
]);

/**
 * Validate an HMAC-SHA256-of-body webhook signature. This is the ideal
 * (body-bound) auth path, used by internal callers and tests that can
 * compute the signature themselves.
 */
function hmacSignatureMatches(
  signatureHeader: string | undefined,
  rawBody: string | Buffer,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Validate a static bearer token in the `Authorization` header.
 *
 * Helius webhooks (as of 2026-04) do not HMAC-sign payloads — the
 * `authHeader` configured on the webhook is sent verbatim as the
 * Authorization header on every delivery. That means our only practical
 * path to authenticate real Helius deliveries is a shared static secret.
 *
 * Tradeoff vs HMAC: a static token leaks → attacker can replay arbitrary
 * bodies. Mitigations: secret is 64+ chars, TLS-only ingress, secret
 * rotatable by re-running sync-helius-webhook.
 */
function staticTokenMatches(
  authHeader: string | undefined,
  secret: string,
): boolean {
  if (!authHeader) return false;
  const expected = `Bearer ${secret}`;
  const providedBuf = Buffer.from(authHeader);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export async function monitoringRoutes(app: FastifyInstance) {
  const monitor = new TransactionMonitor(app.db, app.redis, app.config.ALERT_HMAC_SECRET);

  /** GET /api/monitoring/events — Recent monitoring events */
  app.get('/api/monitoring/events', async (request, reply) => {
    const { limit, agent } = z
      .object({
        limit: z.coerce.number().min(1).max(100).default(50),
        agent: z.string().optional(),
      })
      .parse(request.query);

    const conditions = agent ? eq(monitoringEvents.agentAddress, agent) : undefined;

    const events = await app.db
      .select()
      .from(monitoringEvents)
      .where(conditions)
      .orderBy(desc(monitoringEvents.createdAt))
      .limit(limit);

    return reply.send({ events });
  });

  /** POST /api/monitoring/webhook — Helius webhook endpoint */
  app.post('/api/monitoring/webhook', async (request, reply) => {
    const secret = app.config.HELIUS_WEBHOOK_SECRET;
    const hmacHeader = request.headers['x-helius-hmac-signature'] as string | undefined;
    const authHeader = request.headers['authorization'] as string | undefined;

    const rawBody =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);

    // Accept either: HMAC-of-body (preferred, used by internal callers +
    // tests) OR static bearer token (what real Helius actually sends).
    const authorized =
      hmacSignatureMatches(hmacHeader, rawBody, secret) ||
      staticTokenMatches(authHeader, secret);
    if (!authorized) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const parsed = webhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Malformed webhook payload' });
    }

    await monitor.processWebhook(parsed.data);

    return reply.status(200).send({ processed: true });
  });

  /**
   * GET /api/monitoring/metrics — Diagnostic counters and policy-lag health.
   *
   * Exposes cumulative counters written by {@link TransactionMonitor}
   * (matched, skipped-uninsured, skipped-inactive, anomalies) plus a
   * `policyLag` block that surfaces stuck policies: rows still state=Active
   * past their expiry_time, with the worst lag in seconds. A non-zero
   * `stuckCount` means the expiry-crank or policy-indexer is falling behind.
   *
   * Intentionally public/GET — no secrets are exposed, and wiring it into
   * Prometheus/Grafana scrapes later is a one-liner.
   */
  app.get('/api/monitoring/metrics', async (_request, reply) => {
    const counters = await readMonitorMetrics(app.redis);

    const now = new Date();
    const [stuckAgg] = await app.db
      .select({
        count: sql<number>`count(*)`,
        oldestExpiry: sql<Date | null>`min(${policies.expiryTime})`,
      })
      .from(policies)
      .where(and(eq(policies.state, PolicyState.Active), lt(policies.expiryTime, now)));

    const stuckCount = Number(stuckAgg?.count ?? 0);
    const oldestExpiry = stuckAgg?.oldestExpiry ? new Date(stuckAgg.oldestExpiry) : null;
    const maxLagSec = oldestExpiry
      ? Math.max(0, Math.floor((now.getTime() - oldestExpiry.getTime()) / 1000))
      : 0;

    return reply.send({
      monitor: counters,
      policyLag: {
        stuckCount,
        maxLagSec,
        oldestExpiry: oldestExpiry?.toISOString() ?? null,
      },
      now: now.toISOString(),
    });
  });

  /** POST /api/demo/simulate-exploit — Simulate an exploit for demo (development only).
   *  Guarded by NODE_ENV so the `simulated` flag can never originate in
   *  production. */
  app.post('/api/demo/simulate-exploit', async (request, reply) => {
    if (app.config.NODE_ENV === 'production') {
      return reply.status(404).send({ error: 'Not found' });
    }

    const { agentAddress, type } = z
      .object({
        agentAddress: z.string().regex(SOLANA_ADDRESS_REGEX, 'Invalid Solana address'),
        type: z.enum(['exploit', 'oracle_deviation', 'agent_error', 'governance_attack']),
      })
      .parse(request.body);

    await app.db.insert(monitoringEvents).values({
      agentAddress,
      eventType: type,
      severity: 'critical',
      txSignature: generateDemoTxSignature(),
      details: {
        simulated: true,
        type,
        timestamp: Date.now(),
      },
    });

    await publishAlert(app.redis, app.config.ALERT_HMAC_SECRET, {
      channel: 'monitoring:alerts',
      event: type,
      data: { agentAddress, type, simulated: true },
      timestamp: Date.now(),
    });

    return reply.send({ success: true, message: `Simulated ${type} for ${agentAddress}` });
  });
}
