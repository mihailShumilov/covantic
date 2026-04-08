import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';

/** Simple rate limiter using Redis.
 * Limits to 100 requests per minute per IP. */
export function registerRateLimit(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    const redis: Redis = app.redis;
    const ip = request.ip;
    const key = `rate:${ip}`;

    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, 60);
    }

    if (current > 100) {
      return reply.status(429).send({ error: 'Too many requests' });
    }
  });
}
