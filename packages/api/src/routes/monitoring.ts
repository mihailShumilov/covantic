import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { monitoringEvents } from '../db/schema.js';
import { TransactionMonitor } from '../services/transaction-monitor.js';

export async function monitoringRoutes(app: FastifyInstance) {
  const monitor = new TransactionMonitor(app.db, app.redis);

  /** GET /api/monitoring/events — Recent monitoring events */
  app.get('/api/monitoring/events', async (request, reply) => {
    const { limit, agent } = z
      .object({
        limit: z.coerce.number().default(50),
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
    // Verify webhook secret if configured
    const secret = app.config.HELIUS_WEBHOOK_SECRET;
    if (secret) {
      const authHeader = request.headers.authorization;
      if (authHeader !== secret) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }

    const payload = request.body as any[];
    await monitor.processWebhook(Array.isArray(payload) ? payload : [payload]);

    return reply.status(200).send({ processed: true });
  });

  /** POST /api/demo/simulate-exploit — Simulate an exploit for demo */
  app.post('/api/demo/simulate-exploit', async (request, reply) => {
    const { agentAddress, type } = z
      .object({
        agentAddress: z.string(),
        type: z.enum(['exploit', 'oracle_deviation', 'agent_error', 'governance_attack']),
      })
      .parse(request.body);

    // Create simulated monitoring event
    await app.db.insert(monitoringEvents).values({
      agentAddress,
      eventType: type,
      severity: 'critical',
      txSignature: `demo_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      details: {
        simulated: true,
        type,
        timestamp: Date.now(),
      },
    });

    // Broadcast via Redis
    await app.redis.publish(
      'monitoring:alerts',
      JSON.stringify({
        channel: 'monitoring:alerts',
        event: type,
        data: { agentAddress, type, simulated: true },
        timestamp: Date.now(),
      }),
    );

    return reply.send({ success: true, message: `Simulated ${type} for ${agentAddress}` });
  });
}
