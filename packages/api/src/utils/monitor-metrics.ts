import type Redis from 'ioredis';
import { logger } from './logger.js';

/**
 * Lightweight, Redis-backed counters for the transaction monitor.
 *
 * Prometheus-style histograms are overkill for the debug question these
 * counters answer: "why did my webhook not produce an alert?" — so we stick
 * to cheap cumulative INCRs keyed by reason. Read back via
 * {@link readMonitorMetrics} for `/api/monitoring/metrics`.
 *
 * Counters are cumulative since first write. Redis persists them across
 * restarts; reset with `redis-cli DEL covantic:metrics:monitor:*`.
 */

const PREFIX = 'covantic:metrics:monitor';

export type MonitorMetric =
  /** Webhooks that carried no identifiable fromUserAccount address. */
  | 'skipped:no_addresses'
  /** Addresses seen in a tx for which we have no policy row at all. */
  | 'skipped:uninsured'
  /** Addresses with at least one policy, but none in state=Active. */
  | 'skipped:inactive_policy'
  /** Addresses matched to an Active policy (anomaly check then runs). */
  | 'matched:active'
  /** Anomalies that cleared the threshold and were published. */
  | 'anomaly:warning'
  | 'anomaly:critical'
  /** Per-transaction processing errors (see transactionError path). */
  | 'error:tx';

export async function incrementMetric(
  redis: Redis,
  metric: MonitorMetric,
  by = 1,
): Promise<void> {
  try {
    await redis.incrby(`${PREFIX}:${metric}`, by);
  } catch (err) {
    logger.warn({ err, metric }, 'Failed to increment monitor metric');
  }
}

export async function readMonitorMetrics(
  redis: Redis,
): Promise<Record<MonitorMetric, number>> {
  const keys: MonitorMetric[] = [
    'skipped:no_addresses',
    'skipped:uninsured',
    'skipped:inactive_policy',
    'matched:active',
    'anomaly:warning',
    'anomaly:critical',
    'error:tx',
  ];
  const values = await redis.mget(...keys.map((k) => `${PREFIX}:${k}`));
  const out = {} as Record<MonitorMetric, number>;
  keys.forEach((k, i) => {
    out[k] = Number(values[i] ?? 0);
  });
  return out;
}
