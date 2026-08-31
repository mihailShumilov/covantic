import { describe, expect, it, vi, afterEach } from 'vitest';
import type { RpcTransport } from '@solana/kit';
import {
  CovanticRpcPool,
  describeRpcFailure,
  parseRpcEndpoints,
  rpcEndpointName,
} from '../src/config/rpc-pool.js';

/**
 * The read pool's failure behaviour.
 *
 * What is worth testing here is not that a healthy endpoint answers — it is
 * what happens when one stops answering, because that is the case that took
 * the whole service down when there was only ever one endpoint. A live RPC
 * will not 429 on demand, so every endpoint here is a fake transport.
 */

const HELIUS = 'https://devnet.helius-rpc.com/?api-key=secret-key-value';
const PUBLIC = 'https://api.devnet.solana.com';

/** A transport that answers `getSlot` with a fixed slot. */
function ok(slot: bigint, calls: string[] = [], name = 'ok'): RpcTransport {
  return (async () => {
    calls.push(name);
    return { jsonrpc: '2.0', id: 1, result: slot };
  }) as unknown as RpcTransport;
}

/** A transport that always throws the given error. */
function failing(err: unknown, calls: string[] = [], name = 'bad'): RpcTransport {
  return (async () => {
    calls.push(name);
    throw err;
  }) as unknown as RpcTransport;
}

/** The shape `@solana/kit` throws on an HTTP error: status under `context`. */
function kitHttpError(statusCode: number): Error {
  const err = new Error(`HTTP error (${statusCode})`);
  (err as { context?: unknown }).context = { statusCode };
  return err;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('endpoint parsing', () => {
  it('names an endpoint by host so a provider key is never logged', () => {
    expect(rpcEndpointName(HELIUS)).toBe('devnet.helius-rpc.com');
    expect(rpcEndpointName(HELIUS)).not.toContain('secret-key-value');
  });

  it('keeps the primary first and appends fallbacks in order', () => {
    const specs = parseRpcEndpoints(HELIUS, `${PUBLIC}, https://rpc.example.org`);

    expect(specs.map((s) => s.name)).toEqual([
      'devnet.helius-rpc.com',
      'api.devnet.solana.com',
      'rpc.example.org',
    ]);
  });

  it('drops blanks and collapses a fallback that repeats the primary', () => {
    const specs = parseRpcEndpoints(PUBLIC, `  , ${PUBLIC} ,`);

    expect(specs).toHaveLength(1);
    expect(specs[0]?.url).toBe(PUBLIC);
  });

  it('disambiguates two endpoints on the same host', () => {
    const specs = parseRpcEndpoints(`${HELIUS}`, 'https://devnet.helius-rpc.com/?api-key=other');

    expect(specs.map((s) => s.name)).toEqual([
      'devnet.helius-rpc.com',
      'devnet.helius-rpc.com#2',
    ]);
  });

  it('refuses to build a pool with no usable endpoint', () => {
    expect(() => new CovanticRpcPool({ primaryUrl: '   ' })).toThrow(/no usable endpoint/);
  });
});

describe('failover', () => {
  it('serves the request from the next endpoint when the first fails', async () => {
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS ? failing(new Error('down'), calls, 'primary') : ok(42n, calls, 'fallback'),
    });

    expect(await pool.rpc.getSlot().send()).toBe(42n);
    expect(calls).toEqual(['primary', 'fallback']);
  });

  it('reports the per-endpoint cause when every endpoint fails', async () => {
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) => failing(new Error(url === HELIUS ? 'quota' : 'timeout')),
    });

    const err = await pool.rpc
      .getSlot()
      .send()
      .catch((e: unknown) => e);
    const described = describeRpcFailure(err);

    expect(described).toContain('devnet.helius-rpc.com: quota');
    expect(described).toContain('api.devnet.solana.com: timeout');
  });
});

describe('circuit breaker', () => {
  it('stops calling an endpoint after repeated failures', async () => {
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS ? failing(new Error('down'), calls, 'primary') : ok(1n, calls, 'fallback'),
    });

    for (let i = 0; i < 5; i++) await pool.rpc.getSlot().send();

    // Three attempts trip it; the remaining two requests skip it entirely.
    expect(calls.filter((c) => c === 'primary')).toHaveLength(3);
    expect(calls.filter((c) => c === 'fallback')).toHaveLength(5);
  });

  it('retries the endpoint once its cooldown has passed', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let healthy = false;
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS
          ? ((async () => {
              calls.push('primary');
              if (!healthy) throw new Error('down');
              return { jsonrpc: '2.0', id: 1, result: 7n };
            }) as unknown as RpcTransport)
          : ok(1n, calls, 'fallback'),
    });

    for (let i = 0; i < 4; i++) await pool.rpc.getSlot().send();
    expect(calls.filter((c) => c === 'primary')).toHaveLength(3);

    // An ordinary failure is a 30s cooldown; nothing before it expires.
    vi.setSystemTime(Date.now() + 31_000);
    healthy = true;

    expect(await pool.rpc.getSlot().send()).toBe(7n);
    // Four attempts plus the kit's half-open recovery probe, which is what
    // asks a de-ranked endpoint whether it is back.
    expect(calls.filter((c) => c === 'primary').length).toBeGreaterThanOrEqual(4);
  });

  it('holds a rate-limited endpoint out far longer than a failing one', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS ? failing(kitHttpError(429), calls, 'primary') : ok(1n, calls, 'fallback'),
    });

    for (let i = 0; i < 3; i++) await pool.rpc.getSlot().send();
    expect(calls.filter((c) => c === 'primary')).toHaveLength(3);

    // Past the ordinary 30s cooldown, a 429'd provider is still held out:
    // retrying it on that cadence is how a daily quota never recovers.
    vi.setSystemTime(Date.now() + 60_000);
    await pool.rpc.getSlot().send();
    expect(calls.filter((c) => c === 'primary')).toHaveLength(3);

    vi.setSystemTime(Date.now() + 5 * 60_000);
    await pool.rpc.getSlot().send();
    expect(calls.filter((c) => c === 'primary')).toHaveLength(4);
  });

  it('recognises a 429 the kit reports under `context`', async () => {
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) => (url === HELIUS ? failing(kitHttpError(429)) : ok(1n)),
    });

    await pool.rpc.getSlot().send();

    // The kit's own rate-limit metric reads a top-level `statusCode`; without
    // the normalisation this counter stays at zero while a provider throttles.
    expect(pool.status().rateLimited).toBe(1);
  });
});

describe('status', () => {
  it('does not count a skipped endpoint as a failed request', async () => {
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) => (url === HELIUS ? failing(new Error('down')) : ok(1n)),
    });

    for (let i = 0; i < 5; i++) await pool.rpc.getSlot().send();

    const status = pool.status();
    const primary = status.endpoints[0]!;

    expect(primary.ejected).toBe(true);
    // The kit does not count a skipped endpoint as a request at all.
    expect(status.requests).toBe(8);
    expect(primary.cooldownSec).toBeGreaterThan(0);
    // 5 requests served + 3 failed attempts, with the 2 skips excluded.
    expect(status.requests).toBe(8);
    expect(status.failures).toBe(3);
    expect(status.endpoints[1]?.healthy).toBe(true);
  });
});

describe('JSON-RPC error bodies', () => {
  /** A node reports being behind with HTTP 200 and an `error` body. */
  function nodeBehind(calls: string[] = [], name = 'behind'): RpcTransport {
    return (async () => {
      calls.push(name);
      return {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32005, message: 'Node is unhealthy; behind by 1500 slots' },
      };
    }) as unknown as RpcTransport;
  }

  it('fails over when a node answers 200 with a node-state error', async () => {
    // The failure class most likely to be answerable by a *different* endpoint
    // arrives as a success at the HTTP layer. If it is not converted to a
    // throw here, the pool returns it and never tries the fallback.
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS ? nodeBehind(calls, 'primary') : ok(9n, calls, 'fallback'),
    });

    expect(await pool.rpc.getSlot().send()).toBe(9n);
    expect(calls).toEqual(['primary', 'fallback']);
  });

  it('counts a node-state error against the endpoint, so the breaker can open', async () => {
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS ? nodeBehind(calls, 'primary') : ok(1n, calls, 'fallback'),
    });

    for (let i = 0; i < 5; i++) await pool.rpc.getSlot().send();

    expect(calls.filter((c) => c === 'primary')).toHaveLength(3);
    expect(pool.status().endpoints[0]?.ejected).toBe(true);
    expect(pool.status().failures).toBe(3);
  });

  it('treats a provider rate-limit error code as a 429', async () => {
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS
          ? ((async () => ({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32429, message: 'Too many requests' },
            })) as unknown as RpcTransport)
          : ok(1n),
    });

    await pool.rpc.getSlot().send();

    expect(pool.status().rateLimited).toBe(1);
  });

  it('does not blame an endpoint for a malformed request', async () => {
    // Every endpoint would answer the same way, so counting it would let one
    // bad call trip a healthy provider's breaker.
    const calls: string[] = [];
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) =>
        url === HELIUS
          ? ((async () => {
              calls.push('primary');
              return {
                jsonrpc: '2.0',
                id: 1,
                error: { code: -32602, message: 'Invalid params' },
              };
            }) as unknown as RpcTransport)
          : ok(1n, calls, 'fallback'),
    });

    for (let i = 0; i < 5; i++) {
      await pool.rpc
        .getSlot()
        .send()
        .catch(() => undefined);
    }

    // Every request still reached the primary: a malformed call is the
    // caller's fault, and ejecting a healthy provider for it would let one bad
    // request take a working endpoint out of rotation for 30 seconds.
    expect(calls.filter((c) => c === 'primary')).toHaveLength(5);
    expect(pool.status().endpoints[0]?.ejected).toBe(false);
  });
});

describe('cluster verification', () => {
  function genesis(hash: string): RpcTransport {
    return (async () => ({ jsonrpc: '2.0', id: 1, result: hash })) as unknown as RpcTransport;
  }
  const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

  it('ejects a fallback that serves a different cluster', async () => {
    // A wrong-chain endpoint answers "this account does not exist"
    // authoritatively, and the reader is required to report that as absence —
    // which turns a holder's matured declaration into a record it was never made.
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) => (url === HELIUS ? genesis(DEVNET) : genesis(MAINNET)),
    });

    await pool.verifyCluster('devnet');

    expect(pool.status().endpoints[1]?.cooldownSec).toBeGreaterThan(0);
    expect(pool.status().endpoints[0]?.cooldownSec).toBe(0);
  });

  it('refuses to start when the primary serves a different cluster', async () => {
    // The primary is also the endpoint every transaction is sent to.
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: () => genesis(MAINNET),
    });

    await expect(pool.verifyCluster('devnet')).rejects.toThrow(/serves mainnet-beta, not devnet/);
  });

  it('keeps an endpoint that could not be probed', async () => {
    // An outage at boot is not evidence of the wrong cluster, and refusing to
    // start on it would turn a transient failure into a dead deployment.
    const pool = new CovanticRpcPool({
      primaryUrl: HELIUS,
      fallbackUrls: PUBLIC,
      transportFactory: (url) => (url === HELIUS ? genesis(DEVNET) : failing(new Error('down'))),
    });

    await pool.verifyCluster('devnet');

    expect(pool.status().endpoints[1]?.cooldownSec).toBe(0);
  });
});
