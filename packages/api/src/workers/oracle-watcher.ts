import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { PolicyState } from '@covantic/shared';
import type { Database } from '../config/database.js';
import type { AppConfig } from '../config/env.js';
import { monitoringEvents, policies } from '../db/schema.js';
import { HeliusClient, type EnhancedTransaction } from '../utils/helius.js';
import { logger } from '../utils/logger.js';
import { publishAlert } from '../services/alert-bus.js';
import { buildPriceOracle } from '../services/oracle/factory.js';
import { screenForOracleDeviation } from '../services/oracle/prefilter.js';
import type { ConsensusPricer } from '../services/oracle/consensus.js';

const QUEUE_NAME = 'oracle-watcher';

/** How often the sweep runs. Oracle manipulation resolves in a slot or two,
 *  but the claim it produces stays valid for the life of the policy, so the
 *  cost of finding it minutes late is small next to never finding it. */
const SWEEP_INTERVAL_MS = 120_000;

/** How far back each sweep looks. Comfortably wider than the interval so a
 *  slow tick or a restart does not open a hole. */
const LOOKBACK_SEC = 900;

/** Transactions pulled per agent per sweep. */
const TX_PER_AGENT = 25;

/** Agents examined per sweep, newest policies first. Bounds the work when
 *  the fleet grows; the cap is logged rather than silently applied. */
const MAX_AGENTS_PER_SWEEP = 50;

/**
 * Backstop detection for oracle manipulation.
 *
 * The webhook path is the fast one, and it is also the fragile one: Helius
 * deliveries get dropped, the endpoint goes down during a deploy, the webhook
 * registration drifts out of sync with the insured set. Any of those turns
 * into a policyholder who was squeezed and never got a claim, and nothing in
 * the system would have noticed.
 *
 * So detection is also pulled, not only pushed. Every couple of minutes this
 * re-reads recent transactions for insured agents and runs the same screen
 * the webhook path runs. Alerts are deduplicated against `monitoring_events`
 * by signature, so an incident already caught by the webhook does not produce
 * a second one here.
 */
export function startOracleWatcher(db: Database, redis: Redis, config: AppConfig) {
  if (!config.HELIUS_API_KEY) {
    logger.warn('Oracle watcher disabled: HELIUS_API_KEY not configured');
    return null;
  }

  const helius = new HeliusClient(config.HELIUS_API_KEY, config.SOLANA_NETWORK);
  const priceOracle = buildPriceOracle();
  const queue = new Queue(QUEUE_NAME, { connection: redis });

  queue.upsertJobScheduler(
    'sweep-insured-agents',
    { every: SWEEP_INTERVAL_MS },
    {
      name: 'sweep',
      opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await sweep(db, redis, config, helius, priceOracle);
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => logger.error({ job: job?.id, err }, 'oracle watcher failed'));

  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'Oracle watcher started');
  return { queue, worker };
}

async function sweep(
  db: Database,
  redis: Redis,
  config: AppConfig,
  helius: HeliusClient,
  priceOracle: ConsensusPricer,
): Promise<void> {
  const active = await db
    .select({ agentAddress: policies.agentAddress })
    .from(policies)
    .where(eq(policies.state, PolicyState.Active));

  const agents = [...new Set(active.map((row) => row.agentAddress))];
  const examined = agents.slice(0, MAX_AGENTS_PER_SWEEP);
  if (agents.length > examined.length) {
    // Never let a bound silently narrow coverage — a sweep that skipped half
    // the fleet must not read as a clean sweep.
    logger.warn(
      { total: agents.length, examined: examined.length },
      'oracle watcher: agent cap reached, remainder not swept this tick',
    );
  }
  if (examined.length === 0) return;

  const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_SEC;
  let flagged = 0;

  for (const agentAddress of examined) {
    let txs: EnhancedTransaction[];
    try {
      txs = await helius.getEnhancedTransactions(agentAddress, { limit: TX_PER_AGENT });
    } catch (err) {
      logger.warn({ err, agentAddress }, 'oracle watcher: transaction fetch failed');
      continue;
    }

    for (const tx of txs) {
      if (!tx.signature || (tx.timestamp ?? 0) < cutoff) continue;
      if (await alreadySeen(db, tx.signature)) continue;

      let screen;
      try {
        screen = await screenForOracleDeviation(tx, agentAddress, priceOracle);
      } catch (err) {
        logger.warn({ err, signature: tx.signature }, 'oracle watcher: screen failed');
        continue;
      }
      if (!screen.flagged) continue;

      await db.insert(monitoringEvents).values({
        agentAddress,
        eventType: 'oracle_deviation',
        severity: screen.severity,
        txSignature: tx.signature,
        details: { screenReason: screen.reason, source: 'oracle-watcher', ...screen.detail },
      });

      await publishAlert(redis, config.ALERT_HMAC_SECRET, {
        channel: 'monitoring:alerts',
        event: 'oracle_deviation',
        data: {
          agentAddress,
          type: 'oracle_deviation',
          txSignature: tx.signature,
          severity: screen.severity,
          screenReason: screen.reason,
        },
        timestamp: Date.now(),
      });

      flagged += 1;
      logger.warn(
        { agentAddress, signature: tx.signature, reason: screen.reason },
        'oracle watcher: flagged a swap the webhook path did not',
      );
    }
  }

  logger.info({ agents: examined.length, flagged }, 'oracle watcher: sweep complete');
}

/**
 * Has this transaction already produced an event?
 *
 * Keyed on the signature alone rather than the event type: if the webhook
 * path already raised anything for this transaction, the claim keeper has
 * seen it, and a policy can hold only one open claim regardless.
 */
async function alreadySeen(db: Database, signature: string): Promise<boolean> {
  const [row] = await db
    .select({ id: monitoringEvents.id })
    .from(monitoringEvents)
    .where(and(eq(monitoringEvents.txSignature, signature)))
    .limit(1);
  return row !== undefined;
}
