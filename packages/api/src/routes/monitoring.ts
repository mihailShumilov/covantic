import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  MonitoringEventType,
  PolicyState,
  SOLANA_ADDRESS_REGEX,
  generateDemoTxSignature,
} from '@covantic/shared';
import { monitoringEvents, policies } from '../db/schema.js';
import { TransactionMonitor } from '../services/transaction-monitor.js';
import { buildPriceOracle } from '../services/oracle/factory.js';
import { publishAlert } from '../services/alert-bus.js';
import { readMonitorMetrics } from '../utils/monitor-metrics.js';
import { MandateReader } from '../services/agent-error/mandate.js';
import { createCovanticProgram } from '../utils/program.js';
import { logger } from '../utils/logger.js';

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
function staticTokenMatches(authHeader: string | undefined, secret: string): boolean {
  if (!authHeader) return false;
  const expected = `Bearer ${secret}`;
  const providedBuf = Buffer.from(authHeader);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Build a mandate reader, or `undefined` when the program cannot be loaded.
 *
 * Returning `undefined` rather than throwing is what keeps monitoring alive on
 * a deployment that cannot reach the program: the screen then reports the
 * mandate as *unreadable* rather than *undeclared*, which is the difference
 * between failing open and silently deciding nobody has coverage.
 */
function buildMandateReader(config: FastifyInstance['config']): MandateReader | undefined {
  try {
    return new MandateReader(createCovanticProgram(config, { withOracle: false }));
  } catch (err) {
    logger.warn({ err }, 'monitoring: mandate reader unavailable; screening will fail open');
    return undefined;
  }
}

export async function monitoringRoutes(app: FastifyInstance) {
  // Capture the exact bytes before JSON parsing, so the HMAC is computed over
  // what was actually signed rather than over a re-serialisation of the parsed
  // object. Scoped to this plugin, so the rest of the API keeps Fastify's
  // default JSON handling.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      done(null, body === '' ? {} : JSON.parse(body));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // The mandate reader is optional and built lazily: a deployment with no
  // oracle keypair still monitors, it simply cannot read the declared
  // envelopes — and the screen fails open in that case rather than treating
  // every agent as having declared nothing.
  const mandateReader = buildMandateReader(app.config);

  const monitor = new TransactionMonitor(
    app.db,
    app.redis,
    app.config.ALERT_HMAC_SECRET,
    buildPriceOracle(),
    mandateReader
      ? (holderAddress, policyId) =>
          mandateReader.readMandate(holderAddress, BigInt(policyId), Math.floor(Date.now() / 1000))
      : undefined,
    app.config.USDC_MINT,
  );

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

    // The exact bytes that were signed, when the raw-body parser captured
    // them. Re-serialising `request.body` produces a *different* string for
    // the same payload — key order, whitespace, number formatting — so a
    // signature computed by any real body-bound signer would never verify.
    // It happened to work only because both sides re-serialised identically.
    const rawBody =
      (request as { rawBody?: string }).rawBody ??
      (typeof request.body === 'string' ? request.body : JSON.stringify(request.body));

    // Accept either: HMAC-of-body (preferred, used by internal callers +
    // tests) OR static bearer token (what real Helius actually sends).
    //
    // Two secrets, not one. Sharing them meant anyone who saw an
    // `Authorization` header — a proxy log, an ngrok dashboard, a support
    // ticket — also held the HMAC key. `HELIUS_WEBHOOK_BEARER` falls back to
    // the shared secret so existing deployments keep working.
    const bearerSecret = app.config.HELIUS_WEBHOOK_BEARER ?? secret;
    const authorized =
      hmacSignatureMatches(hmacHeader, rawBody, secret) ||
      staticTokenMatches(authHeader, bearerSecret);
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
        type: z.enum([
          MonitoringEventType.Exploit,
          MonitoringEventType.OracleDeviation,
          MonitoringEventType.AgentError,
          MonitoringEventType.GovernanceAttack,
        ]),
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
