import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { registerCoveredMint } from '@covantic/shared';
import { loadConfig } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { applyCustomConstraints } from './db/custom-constraints.js';
import { createDbConnection } from './config/database.js';
import { createRedisConnection } from './config/redis.js';
import { registerRoutes } from './routes/index.js';
import { registerWorkers } from './workers/index.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { createSolanaConnection } from './config/solana.js';
import { getSolanaReader, verifyReaderCluster } from './utils/solana-reader.js';
import { NotificationService } from './services/notification-service.js';
import { AttestationPublisher } from './services/attestation-publisher.js';
import { logger } from './utils/logger.js';
import './types/index.js';

const ALLOWED_WS_CHANNELS = ['claims:feed', 'vault:stats', 'monitoring:alerts'];
const AGENT_CHANNEL_PREFIX = 'agent:';

/**
 * Resolve `TRUST_PROXY` into something Fastify can be trusted with.
 *
 * Anything that is not an explicit `false`, a hop count, or a CIDR/IP list
 * becomes the default single hop rather than blanket trust — the failure
 * direction matters, because `true` hands `request.ip` to the caller.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined) return 1;
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'true') return 1;
  if (value.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

async function bootstrap() {
  // 1. Load and validate config
  const config = loadConfig();
  // Before anything can price a loss. A deployment's mock USDC is not in the
  // shared registry, and without this every claim stalls at
  // `position_not_valued`.
  registerCoveredMint(config.USDC_MINT);

  // 2. Auto-migrate DB
  const db = createDbConnection(config.DATABASE_URL);
  await runMigrations(config.DATABASE_URL);
  await applyCustomConstraints(db);

  // 3. Create connections
  const redis = createRedisConnection(config.REDIS_URL);
  const solanaConnection = createSolanaConnection(config.SOLANA_RPC_URL);
  const solanaReader = getSolanaReader(config);
  // Before any read depends on it. A wrong-cluster endpoint answers
  // authoritatively that accounts do not exist, which this service is
  // required to read as absence — so it must never be in rotation.
  await verifyReaderCluster(config);

  // 4. Create Fastify instance. trustProxy lets us honour X-Forwarded-For
  // from the nginx front-end so per-IP rate limits key on the real client IP,
  // not the Docker gateway.
  //
  // A *hop count*, never `true`. With `true`, Fastify walks the whole
  // X-Forwarded-For chain and returns its leftmost entry — which nginx
  // prepends verbatim from the client, so `request.ip` becomes an
  // attacker-chosen string and every rate limit here keys on it. With `1` it
  // walks exactly one hop and lands on nginx's own `$remote_addr`.
  // `TRUST_PROXY=false` still disables it outright, and a CIDR string is
  // honoured for a more complex front end.
  const trustProxy = parseTrustProxy(config.TRUST_PROXY);
  const app = Fastify({
    trustProxy,
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
      ? ['https://covantic.org', 'https://www.covantic.org']
      : [/^http:\/\/localhost:\d+$/];
  await app.register(fastifyCors, { origin: allowedOrigins });
  await app.register(fastifyWebSocket);

  // 6. Decorate with shared resources
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('config', config);
  app.decorate('solanaConnection', solanaConnection);
  app.decorate('solanaReader', solanaReader);
  app.decorate('attestationPublisher', new AttestationPublisher(config));

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

/**
 * A rejected promise nobody awaited must not take the service down.
 *
 * Node's default for an unhandled rejection is to throw, which exits. That is
 * the right default for a script and the wrong one for a long-running service
 * whose dependencies rate-limit: a single `429 Too Many Requests` from a
 * floating promise inside `@solana/web3.js` — its blockhash refresh, its
 * subscription reconnect — killed the API roughly every forty-five seconds,
 * and `restart: unless-stopped` dutifully brought it back to do it again.
 * Every restart re-ran migrations, restarted every worker, and dropped
 * whatever was in flight, over a condition that resolves by waiting.
 *
 * There are no application frames in that stack, so there is no call site to
 * put a `catch` on. The handler is the only place it can be caught.
 *
 * It is deliberately loud rather than silent. Swallowing unhandled rejections
 * is how a real defect hides for a month, so this logs at error level with the
 * stack intact — the same signal a crash gave, without the crash.
 *
 * `uncaughtException` is left alone on purpose. A synchronous throw that
 * reached the top of the stack has left the process in a state nobody
 * reasoned about, and continuing from there is a different and worse bet than
 * continuing from a rejected promise.
 */
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason : new Error(String(reason)) },
    'unhandled promise rejection — service continues',
  );
});

bootstrap().catch((err) => {
  logger.error(err, 'Failed to start Covantic API');
  process.exit(1);
});
