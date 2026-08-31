import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { opsReadRateLimit } from '../middleware/rate-limit.js';
import { sql } from 'drizzle-orm';

/**
 * Is this caller the operator?
 *
 * Reuses the webhook bearer rather than introducing another secret, and
 * compares in constant time. Absent a configured secret there is no operator
 * tier and everyone gets the aggregate view — which is the safe direction.
 */
function isOperator(request: FastifyRequest, config: AppConfig): boolean {
  const secret = config.HELIUS_WEBHOOK_BEARER ?? config.HELIUS_WEBHOOK_SECRET;
  if (!secret) return false;
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const offered = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (_request, reply) => {
    const checks: Record<string, string> = {};

    // DB check
    try {
      await app.db.execute(sql`SELECT 1`);
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    // Redis check
    try {
      await app.redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'error';
    }

    const healthy = Object.values(checks).every((v) => v === 'ok');

    reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /api/health/rpc — per-endpoint state of the read pool.
   *
   * Deliberately separate from `/api/health`: that one gates the container's
   * own healthcheck, and a degraded RPC provider must not restart a service
   * that is working. This answers the different question an operator actually
   * asks during an incident — "is the RPC why nothing is being checkpointed?"
   *
   * Always 200. The endpoint list carries the verdict; a non-200 here would
   * be read as "the API is down" by anything polling it.
   */
  app.get(
    '/api/health/rpc',
    { preHandler: [opsReadRateLimit] },
    async (request, reply) => {
      const status = app.solanaReader.status();
      const verdict = status.endpoints.some((e) => e.healthy && e.cooldownSec === 0)
        ? 'ok'
        : 'no-endpoint-available';

      // Per-endpoint detail only for an operator. To an anonymous caller,
      // `rateLimited` and `tripped` are a live success signal for a
      // quota-exhaustion attack, and `no-endpoint-available` announces the
      // window in which nothing is being checkpointed — which is exactly when
      // an incident on an insured agent produces an uncompensated loss. The
      // aggregate verdict is still public, because a monitoring probe needs it.
      if (!isOperator(request, app.config)) {
        reply.send({
          status: verdict,
          endpointsHealthy: status.endpoints.filter((e) => e.healthy && e.cooldownSec === 0).length,
          endpointsConfigured: status.endpoints.length,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      reply.send({ status: verdict, ...status, timestamp: new Date().toISOString() });
    },
  );
}
