import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { loadConfig } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { createDbConnection } from './config/database.js';
import { createRedisConnection } from './config/redis.js';
import { registerRoutes } from './routes/index.js';
import { registerWorkers } from './workers/index.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { createSolanaConnection } from './config/solana.js';
import { NotificationService } from './services/notification-service.js';
import { logger } from './utils/logger.js';
import './types/index.js';

const ALLOWED_WS_CHANNELS = ['claims:feed', 'vault:stats', 'monitoring:alerts'];
const AGENT_CHANNEL_PREFIX = 'agent:';

async function bootstrap() {
  // 1. Load and validate config
  const config = loadConfig();

  // 2. Auto-migrate DB
  const db = createDbConnection(config.DATABASE_URL);
  await runMigrations(config.DATABASE_URL);

  // 3. Create connections
  const redis = createRedisConnection(config.REDIS_URL);
  const solanaConnection = createSolanaConnection(config.SOLANA_RPC_URL);

  // 4. Create Fastify instance
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
          : undefined,
    },
  });

  // 5. Plugins — restrict CORS to known origins
  const allowedOrigins =
    config.NODE_ENV === 'production'
      ? ['https://covantic.xyz', 'https://www.covantic.xyz']
      : [/^http:\/\/localhost:\d+$/];
  await app.register(fastifyCors, { origin: allowedOrigins });
  await app.register(fastifyWebSocket);

  // 6. Decorate with shared resources
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('config', config);
  app.decorate('solanaConnection', solanaConnection);

  // 7. Error handling + rate limiting
  registerErrorHandler(app);
  registerRateLimit(app);

  // 8. Register routes
  await registerRoutes(app);

  // 9. WebSocket handler with channel validation
  const notifications = new NotificationService(redis);
  app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, _req) => {
      socket.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.action === 'subscribe' && typeof msg.channel === 'string') {
            // Validate channel name against allowlist
            const ch = msg.channel;
            const isAllowed =
              ALLOWED_WS_CHANNELS.includes(ch) ||
              (ch.startsWith(AGENT_CHANNEL_PREFIX) && ch.endsWith(':events') && ch.length < 100);
            if (isAllowed) {
              notifications.subscribe(ch, socket);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      });

      socket.on('close', () => {
        notifications.unsubscribe(socket);
      });
    });
  });

  // 10. Start background workers
  registerWorkers(db, redis, config);

  // 11. Start server
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(`Covantic API running on port ${config.PORT}`);
  logger.info(`Environment: ${config.NODE_ENV}`);
  logger.info(`Solana network: ${config.SOLANA_NETWORK}`);
  logger.info(`Program ID: ${config.PROGRAM_ID}`);
}

bootstrap().catch((err) => {
  logger.error(err, 'Failed to start Covantic API');
  process.exit(1);
});
