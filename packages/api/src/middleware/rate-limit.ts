import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';

/** Simple rate limiter using Redis.
 * Limits to 100 requests per minute per IP.
 * Uses a Lua script for atomic INCR+EXPIRE to avoid race conditions. */
export function registerRateLimit(app: FastifyInstance) {
  const luaScript = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
      redis.call('EXPIRE', KEYS[1], 60)
    end
    return current
  `;

  app.addHook('preHandler', async (request, reply) => {
    const redis: Redis = app.redis;
    const ip = request.ip;
    const key = `rate:${ip}`;

    const current = (await redis.eval(luaScript, 1, key)) as number;

    if (current > 100) {
      return reply.status(429).send({ error: 'Too many requests' });
    }
  });
}
