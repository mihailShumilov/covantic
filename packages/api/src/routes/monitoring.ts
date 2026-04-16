import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { SOLANA_ADDRESS_REGEX, generateDemoTxSignature } from '@covantic/shared';
import { monitoringEvents } from '../db/schema.js';
import { TransactionMonitor } from '../services/transaction-monitor.js';
import { publishAlert } from '../services/alert-bus.js';

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
 * Validate a Helius webhook signature as HMAC-SHA256 of the raw body.
 * Only HMAC is accepted: the "raw secret as Bearer token" fallback has
 * been removed as it bypassed the body binding.
 */
function webhookSignatureMatches(
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
    const header = request.headers['x-helius-hmac-signature'] as string | undefined;

    const rawBody =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);

    if (!webhookSignatureMatches(header, rawBody, secret)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const parsed = webhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Malformed webhook payload' });
    }

    await monitor.processWebhook(parsed.data);

    return reply.status(200).send({ processed: true });
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
