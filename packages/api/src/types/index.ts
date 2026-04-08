import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import type Redis from 'ioredis';

/** Extend Fastify instance with custom decorations */
declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    redis: Redis;
    config: AppConfig;
  }
}
