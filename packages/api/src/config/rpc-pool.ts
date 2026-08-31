import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type Rpc,
  type RpcTransport,
  type SolanaRpcApi,
} from '@solana/kit';
import {
  AllEndpointsFailedError,
  CLUSTER_GENESIS_HASHES,
  HealthMonitor,
  LifecycleEmitter,
  ResilientRpcPool,
  type EndpointHealth,
  type Metrics,
  type ResilientEndpoint,
} from 'solana-resilience-kit';
import { logger } from '../utils/logger.js';

/**
 * The read side of Solana access, behind more than one endpoint.
 *
 * Every read this service makes used to go through a single `SOLANA_RPC_URL`.
 * When that provider hit its quota the whole system stopped — including the
 * balance checkpoints the exploit and agent-error proof paths are bounded by,
 * which is the failure mode that turns valid claims into failed ones (see the
 * cranks note in `docs/DEPLOYMENT.md`). One endpoint was a single point of
 * failure for settlement, not merely for latency.
 *
 * `solana-resilience-kit` supplies the routing: a pool of endpoints behind one
 * `RpcTransport`, per-endpoint health, failover on transport errors and 429s,
 * and metrics. Writes are deliberately NOT routed here — Anchor and
 * `sendRawTransaction` keep the web3.js-v1 `Connection` on the primary
 * endpoint, because a transaction that lands twice is worse than one that
 * lands late.
 *
 * ## Invariants
 *
 * - **Order is preference, not round-robin.** `SOLANA_RPC_URL` is first and
 *   stays the endpoint writes use; fallbacks are read-only capacity. A pool
 *   that spread reads evenly would make the paid endpoint's quota irrelevant
 *   and the free one's rate limit the binding constraint.
 * - **A dead endpoint costs no round-trip.** The kit ejects an endpoint that
 *   has failed three times running — 30 s, or 5 minutes after a 429, since a
 *   spent quota needs longer than a blip — and skips it without a network
 *   call. It also treats a JSON-RPC `error` body as a failure, so a node
 *   answering "behind by N slots" with HTTP 200 fails over like any other
 *   fault. Both were local workarounds here until `solana-resilience-kit`
 *   1.4.0 and 1.5.0; nothing in this file re-implements them now.
 * - **Freshness-aware routing is off, and its cost is not the main reason.**
 *   The kit ranks endpoints by a slot each one reports *about itself*, and
 *   `freshestSlot()` is a plain `max()` over those claims — so a single
 *   endpoint reporting an inflated slot marks every honest endpoint stale and
 *   captures all traffic, with no outage required. It also probes `getSlot` on
 *   every endpoint before every request, multiplying volume by the endpoint
 *   count. Freshness is instead *measured* here on a timer, which feeds the
 *   health record without handing routing to an unverified number.
 * - **Every endpoint's cluster is checked once at boot.** A wrong-chain
 *   endpoint answers `getAccountInfo` with an authoritative "does not exist",
 *   which this layer is contractually required to report as absence — turning
 *   a holder's matured declaration into a record that it was never made.
 * - **URLs are never logged.** Provider API keys live in the query string.
 *   Endpoints are named by host, and only the name is ever emitted.
 */

/**
 * How often each endpoint's slot is sampled.
 *
 * Freshness has to be *measured* for `healthy` to mean anything, but the kit
 * measures it by probing every endpoint before every request, which multiplies
 * request volume by the endpoint count. Sampling on a timer decouples the two:
 * one probe per endpoint per interval, regardless of traffic.
 */
const SLOT_PROBE_INTERVAL_MS = 30_000;

/** Slots behind the freshest endpoint before one is considered stale. */
const MAX_SLOT_LAG = 150n;

export interface RpcEndpointSpec {
  /** Host-derived label. Safe to log; carries no credential. */
  name: string;
  url: string;
}

/**
 * Strip credentials from an RPC URL and reduce it to a loggable name.
 *
 * Helius and friends carry the API key in `?api-key=`, so the URL itself is a
 * secret. The host is the only part worth reading in a log line anyway.
 */
export function rpcEndpointName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Build the ordered endpoint list from the primary URL plus optional fallbacks.
 *
 * Pure, so the parsing rules are testable without a network: blanks are
 * dropped, duplicates collapse (a fallback equal to the primary would just
 * double the attempts against one provider), and names are disambiguated when
 * two endpoints share a host.
 */
export function parseRpcEndpoints(primaryUrl: string, fallbackUrls?: string): RpcEndpointSpec[] {
  const raw = [primaryUrl, ...(fallbackUrls ?? '').split(',')]
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  const seen = new Set<string>();
  const specs: RpcEndpointSpec[] = [];
  const nameCounts = new Map<string, number>();

  for (const url of raw) {
    if (seen.has(url)) continue;
    seen.add(url);
    const base = rpcEndpointName(url);
    const n = (nameCounts.get(base) ?? 0) + 1;
    nameCounts.set(base, n);
    specs.push({ name: n === 1 ? base : `${base}#${n}`, url });
  }

  return specs;
}

/**
 * A counting metrics sink.
 *
 * The kit ships `InMemoryMetrics`, whose own docstring calls it a sink "for
 * tests and local debugging": it appends one object per RPC call to arrays
 * nothing prunes. In a process that lives for weeks and reads the chain on
 * every sweep that is an unbounded leak — measured at ~65 bytes per read — and
 * `status()` would compound it by scanning the array on every hit of the health
 * route. The workers share this process with the HTTP server, so the eventual
 * OOM is a settlement outage.
 *
 * Nothing here needs per-call history: the health surface reports rates and
 * totals. Counters give the same answers in O(1) space and O(1) read.
 */
class CountingMetrics implements Metrics {
  requests = 0;
  failures = 0;
  rateLimited = 0;
  private readonly slots = new Map<string, bigint>();

  recordRequest(_endpoint: string, _method: string, _latencyMs: number, ok: boolean): void {
    this.requests += 1;
    if (!ok) this.failures += 1;
  }

  recordRateLimited(_endpoint: string): void {
    this.rateLimited += 1;
  }

  /** Sending does not go through this pool, so these two can never fire. */
  recordRebroadcast(): void {}
  recordLanding(): void {}

  recordSlot(endpoint: string, slot: bigint): void {
    this.slots.set(endpoint, slot);
  }

  lastSlot(endpoint: string): bigint | undefined {
    return this.slots.get(endpoint);
  }
}

export interface RpcPoolConfig {
  /** Primary endpoint; also the endpoint writes use. */
  primaryUrl: string;
  /** Comma-separated read-only fallbacks, in preference order. */
  fallbackUrls?: string;
  /** Probe every endpoint's slot before each request. Costly; default off. */
  freshnessAware?: boolean;
  /**
   * Builds the transport for one endpoint. Defaults to kit's HTTP transport.
   *
   * The seam exists so the breaker and the failover order can be tested
   * without a network — the behaviour worth testing here is what happens when
   * an endpoint misbehaves, which is precisely what a live endpoint will not
   * do on demand.
   */
  transportFactory?: (url: string) => RpcTransport;
  /**
   * Sample endpoint slots on a timer so `healthy` measures freshness.
   *
   * Off by default: constructing this class should not start a timer or issue
   * network traffic. `getSolanaReader` turns it on for the one long-lived pool
   * a process actually runs.
   */
  probeSlots?: boolean;
}

export interface RpcPoolStatus {
  endpoints: Array<{
    name: string;
    healthy: boolean;
    slot: number | null;
    latencyMs: number;
    errorRate: number;
    consecutiveFailures: number;
    /** Seconds until this endpoint is retried, or 0 when it is in rotation. */
    cooldownSec: number;
    /** True while the endpoint is out of rotation. */
    ejected: boolean;
    /** Ejected for good: it answers for a different cluster. */
    wrongCluster: boolean;
  }>;
  /**
   * Requests that actually reached an endpoint.
   *
   * The kit does not record a skipped endpoint as a failed request, so no
   * correction is needed here — it used to be, when ejection was local.
   */
  requests: number;
  failures: number;
  rateLimited: number;
  successRate: number;
}

/**
 * A multi-endpoint Solana read client, plus the health surface an operator
 * needs to answer "is the RPC the reason nothing is being checkpointed?".
 */
export class CovanticRpcPool {
  private readonly pool: ResilientRpcPool;
  private readonly healthMonitor: HealthMonitor;
  private slotProbe: NodeJS.Timeout | null = null;
  private readonly metrics = new CountingMetrics();
  private readonly events = new LifecycleEmitter();
  /** Raw transports, so the cluster probe cannot consume ejection budget. */
  private readonly rawTransports = new Map<string, RpcTransport>();
  /** Endpoints that answered for the wrong cluster. Never retried. */
  private readonly wrongCluster = new Set<string>();
  readonly endpoints: RpcEndpointSpec[];
  readonly rpc: Rpc<SolanaRpcApi>;
  /**
   * One RPC per endpoint, bypassing failover.
   *
   * The pool answers from whichever endpoint replies first, which is right for
   * availability and wrong for a read whose answer decides a claim: a single
   * endpoint's word is then the whole basis for a **rejection**, computed
   * entirely off chain and terminal. `getAccountInfoCorroborated` reads two of
   * these and requires them to agree.
   */
  private readonly perEndpoint: Array<{ name: string; rpc: Rpc<SolanaRpcApi> }> = [];

  constructor(config: RpcPoolConfig) {
    this.endpoints = parseRpcEndpoints(config.primaryUrl, config.fallbackUrls);
    if (this.endpoints.length === 0) {
      throw new Error('rpc-pool: no usable endpoint in SOLANA_RPC_URL');
    }

    const makeTransport =
      config.transportFactory ?? ((url: string) => createDefaultRpcTransport({ url }));
    const poolEndpoints: ResilientEndpoint[] = this.endpoints.map((spec) => {
      const raw = makeTransport(spec.url);
      this.rawTransports.set(spec.name, raw);
      this.perEndpoint.push({ name: spec.name, rpc: createSolanaRpcFromTransport(raw) });
      return { name: spec.name, transport: raw };
    });

    this.events.on('connection:failover', ({ from, to, reason }) => {
      logger.warn({ from, to, reason }, 'rpc-pool: failed over');
    });
    this.events.on('connection:health', ({ endpoint, healthy, slot }) => {
      logger[healthy ? 'info' : 'warn'](
        { endpoint, healthy, slot: slot === null ? null : Number(slot) },
        'rpc-pool: endpoint health changed',
      );
    });

    // Ejection lives here now, not in a local wrapper: three consecutive
    // failures take an endpoint out of rotation for 30 s, or 5 minutes after a
    // 429 — a spent quota needs longer than a blip. The pool skips an ejected
    // endpoint without a network call and, correctly, does not count the skip
    // as a failed request.
    this.healthMonitor = new HealthMonitor({
      endpointNames: this.endpoints.map((e) => e.name),
      maxSlotLag: MAX_SLOT_LAG,
      failureThreshold: 3,
      ejectionMs: 30_000,
      rateLimitEjectionMs: 5 * 60_000,
    });
    this.pool = new ResilientRpcPool({
      endpoints: poolEndpoints,
      freshnessAware: config.freshnessAware ?? false,
      healthMonitor: this.healthMonitor,
      metrics: this.metrics,
      events: this.events,
    });
    this.rpc = this.pool.rpc();

    if (config.freshnessAware) {
      // Not merely a traffic knob: see the note on `freshnessAware` in
      // `RpcPoolConfig`. Say so where an operator will see it.
      logger.warn(
        'rpc-pool: freshness-aware routing is ON — endpoint selection now follows a slot ' +
          'number each endpoint reports about itself, which no other endpoint verifies',
      );
    }
    if (config.probeSlots === true && this.endpoints.length > 1) this.startSlotProbe();

    logger.info(
      { endpoints: this.endpoints.map((e) => e.name), freshnessAware: config.freshnessAware ?? false },
      'rpc-pool: initialised',
    );
  }

  /**
   * Sample every endpoint's slot on a timer so `healthy` measures freshness.
   *
   * Without this the lag branch of `HealthMonitor.isHealthy` is dead code: it
   * only applies once an endpoint's slot is known, and the slot is only
   * recorded from a `getSlot` response, which nothing issues in normal
   * operation. `healthy` then degenerates to "has not failed three times in a
   * row", while `/api/health/rpc` — and the runbook — present it as the signal
   * that reads are being served from a current view of the chain.
   *
   * Cost is one request per endpoint per 30 s, independent of traffic.
   */
  private startSlotProbe(): void {
    const probe = () => {
      for (const spec of this.endpoints) {
        const transport = this.rawTransports.get(spec.name);
        if (!transport) continue;
        const start = Date.now();
        void (async () => {
          try {
            const response = (await transport({
              payload: { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] },
            } as Parameters<RpcTransport>[0])) as { result?: unknown };
            const slot = typeof response.result === 'bigint' ? response.result : undefined;
            this.healthMonitor.recordSuccess(spec.name, Date.now() - start, slot);
          } catch {
            // A probe failure is not a request failure: the endpoint may be
            // serving traffic fine and merely rate-limiting this extra call.
            // Leave the health record to the real requests.
          }
        })();
      }
    };
    this.slotProbe = setInterval(probe, SLOT_PROBE_INTERVAL_MS);
    // Never hold the process open on account of a metrics probe.
    this.slotProbe.unref?.();
    probe();
  }

  /** Stop the slot probe. For tests and clean shutdown. */
  stop(): void {
    if (this.slotProbe) clearInterval(this.slotProbe);
    this.slotProbe = null;
  }

  /**
   * Refuse to serve reads from an endpoint on the wrong chain.
   *
   * This repository already learned this lesson once, in `CLAUDE.md`: Helius
   * Enhanced Transactions are cluster-partitioned, and the wrong cluster
   * "returns `[]` (not an error) and silently breaks every verifier". A plain
   * RPC behaves the same way and worse — `getAccountInfo` on the wrong chain
   * is an authoritative "this account does not exist", which the reader is
   * contractually required to report as absence rather than as an outage. A
   * holder's matured declaration then reads as never made.
   *
   * So the genesis hash is checked once, at boot, before any read depends on
   * it. A mismatched fallback is ejected permanently rather than merely
   * warned about; a mismatched *primary* refuses the process, because that is
   * also the endpoint every transaction is sent to.
   *
   * An endpoint that cannot be probed is left in rotation: an outage at boot
   * is not evidence of the wrong cluster, and refusing to start on it would
   * turn a transient failure into a deployment that will not come up.
   */
  async verifyCluster(expected: string): Promise<void> {
    const results = await Promise.all(
      this.endpoints.map(async (spec) => ({
        spec,
        cluster: await this.probeCluster(spec.name),
      })),
    );

    for (const [index, { spec, cluster }] of results.entries()) {
      if (cluster === null) {
        logger.warn(
          { endpoint: spec.name, expected },
          'rpc-pool: cluster unverified (endpoint did not answer getGenesisHash)',
        );
        continue;
      }
      if (cluster === expected) continue;

      if (index === 0) {
        throw new Error(
          `rpc-pool: SOLANA_RPC_URL (${spec.name}) serves ${cluster}, not ${expected}. ` +
            'Every transaction is sent to this endpoint; refusing to start.',
        );
      }
      // Out of rotation for good: a wrong chain is not a transient condition,
      // so the endpoint is dropped from the pool's view rather than merely
      // ejected on a cooldown the health monitor would later clear.
      this.wrongCluster.add(spec.name);
      logger.error(
        { endpoint: spec.name, serves: cluster, expected },
        'rpc-pool: fallback endpoint is on the wrong cluster — ejected permanently',
      );
    }
  }

  /** The cluster an endpoint serves, or null when it did not answer. */
  private async probeCluster(name: string): Promise<string | null> {
    const transport = this.rawTransports.get(name);
    if (!transport) return null;
    try {
      const response = (await transport({
        payload: { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] },
      } as Parameters<RpcTransport>[0])) as { result?: unknown };
      const hash = typeof response.result === 'string' ? response.result : null;
      if (!hash) return null;
      return (CLUSTER_GENESIS_HASHES as Record<string, string>)[hash] ?? `unknown(${hash})`;
    } catch {
      return null;
    }
  }

  /**
   * Endpoints that can be asked to corroborate one another, freshest first.
   *
   * Excludes anything ejected or on the wrong cluster: a corroborating read
   * must not be answered by an endpoint the pool has already decided against,
   * or "the two agreed" would mean "one answered twice".
   */
  corroboratingEndpoints(): Array<{ name: string; rpc: Rpc<SolanaRpcApi> }> {
    const health = new Map(this.pool.health().map((h) => [h.name, h]));
    return this.perEndpoint.filter(
      (e) => !this.wrongCluster.has(e.name) && !(health.get(e.name)?.ejected ?? false),
    );
  }

  /** Per-endpoint health and the aggregate request outcome, for `/api/health/rpc`. */
  status(): RpcPoolStatus {
    const now = Date.now();
    const health = new Map<string, EndpointHealth>(this.pool.health().map((h) => [h.name, h]));
    return {
      endpoints: this.endpoints.map((spec) => {
        const h = health.get(spec.name);
        const wrongCluster = this.wrongCluster.has(spec.name);
        const ejectedUntil = h?.ejectedUntil ?? null;
        return {
          name: spec.name,
          healthy: !wrongCluster && (h?.healthy ?? true),
          slot: h?.slot === undefined || h?.slot === null ? null : Number(h.slot),
          latencyMs: Math.round(h?.latencyMs ?? 0),
          errorRate: Number((h?.errorRate ?? 0).toFixed(3)),
          consecutiveFailures: h?.consecutiveFailures ?? 0,
          // Ejection is the kit's now. A wrong-cluster endpoint has no
          // cooldown to report, because it is never coming back.
          cooldownSec:
            wrongCluster
              ? Number.POSITIVE_INFINITY
              : ejectedUntil !== null && ejectedUntil > now
                ? Math.ceil((ejectedUntil - now) / 1000)
                : 0,
          ejected: wrongCluster || (h?.ejected ?? false),
          wrongCluster,
        };
      }),
      requests: this.metrics.requests,
      failures: this.metrics.failures,
      rateLimited: this.metrics.rateLimited,
      successRate:
        this.metrics.requests === 0
          ? 1
          : Number(
              ((this.metrics.requests - this.metrics.failures) / this.metrics.requests).toFixed(3),
            ),
    };
  }
}

/**
 * Render a pool failure as one line naming every endpoint that was tried.
 *
 * `AllEndpointsFailedError`'s own message does not carry the per-endpoint
 * causes, and "all endpoints failed" without them is unactionable at 3am.
 */
export function describeRpcFailure(err: unknown): string {
  if (err instanceof AllEndpointsFailedError) {
    const parts = err.attempts.map(
      (a) => `${a.endpoint}: ${a.error instanceof Error ? a.error.message : String(a.error)}`,
    );
    return `all RPC endpoints failed (${parts.join('; ')})`;
  }
  return err instanceof Error ? err.message : String(err);
}
