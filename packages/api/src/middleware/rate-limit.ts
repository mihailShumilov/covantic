import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Redis from 'ioredis';

/** Atomic INCR + EXPIRE via Lua — avoids the race condition between INCR and EXPIRE
 *  where a crash between the two calls would leave a key that never expires. */
const RATE_LIMIT_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  end
  return current
`;

/**
 * Apply a Redis sliding-window rate limit.
 *
 * @param redis   ioredis instance
 * @param key     Redis key (should already include a namespace prefix)
 * @param limit   Max requests allowed within the window
 * @param windowS Window duration in seconds
 * @returns true if the request should be allowed, false if it exceeds the limit
 */
async function checkLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowS: number,
): Promise<boolean> {
  const current = (await redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(windowS))) as number;
  return current <= limit;
}

/** Global rate limiter: 100 requests per minute per IP across all routes. */
export function registerRateLimit(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    const ip = request.ip;
    const allowed = await checkLimit(app.redis, `rate:global:${ip}`, 100, 60);
    if (!allowed) {
      return reply.status(429).send({ error: 'Too many requests' });
    }
  });
}

/**
 * Stricter per-route rate limiter for computationally expensive risk assessment
 * endpoints: 10 requests per minute per IP.
 *
 * Attach as a preHandler on individual routes that trigger on-chain RPC calls,
 * to prevent abuse of the expensive 30-tx sampled analysis pipeline.
 */
export async function riskAssessmentRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const redis = (request.server as FastifyInstance).redis;
  const ip = request.ip;
  const allowed = await checkLimit(redis, `rate:risk:${ip}`, 10, 60);
  if (!allowed) {
    return reply.status(429).send({ error: 'Risk assessment rate limit exceeded. Try again in a minute.' });
  }
}

/**
 * Rate limiter for the demo simulation endpoint: 5 requests per minute per IP.
 *
 * `/api/demo/simulate-exploit` is unauthenticated and injects both a
 * monitoring event and a signed `monitoring:alerts` message — the two inputs
 * the claim-keeper acts on. `syntheticAllowed` keeps it off production, but on
 * every other deployment anyone who finds the URL can name any agent address
 * and drive the claim pipeline. The environment gate decides *whether* it is
 * reachable; this decides how fast.
 *
 * Deliberately tighter than the risk-assessment limit: that endpoint is merely
 * expensive, this one writes to the pipeline.
 */
export async function demoSimulationRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const redis = (request.server as FastifyInstance).redis;
  const ip = request.ip;
  const allowed = await checkLimit(redis, `rate:demo:${ip}`, 5, 60);
  if (!allowed) {
    return reply
      .status(429)
      .send({ error: 'Simulation rate limit exceeded. Try again in a minute.' });
  }
}
