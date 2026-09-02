import { describe, expect, it } from 'vitest';
import type { RpcTransport } from '@solana/kit';
import { CovanticRpcPool } from '../src/config/rpc-pool.js';

/**
 * INV-POOL-01 — an endpoint that says "max usage reached" is not healthy.
 *
 * A spent Helius quota answers **HTTP 200** with a JSON-RPC error body:
 * `{"error":{"code":-32429,"message":"max usage reached"}}`. The raw transport
 * therefore returns rather than throws, and the slot probe called
 * `recordSuccess` on it — recording the dead endpoint as healthy every thirty
 * seconds.
 *
 * Nothing corrected it afterwards. The pool attempts endpoints in
 * configuration order, so a third endpoint is never reached while the first
 * two answer, and `HealthMonitor` has no record of an endpoint until traffic
 * gets there — which `status()` reads as healthy, the optimistic default that
 * is right at start-up and wrong for an endpoint that has never worked.
 *
 * So `/api/health/rpc` reported `3/3 healthy` while one endpoint had told us
 * it was out of quota, in a log line printed at boot. The pool knew. The
 * status said otherwise — the same shape as the six-hour outage this surface
 * was added to expose.
 *
 * CLAUDE.md already states the general rule: "A JSON-RPC error body is a
 * failure, not a success." `withCircuitBreaker` applies it to request traffic.
 * The probe uses the raw transport and so has to apply it itself.
 */

const LIVE = 'https://rpc-live.example.org';
const SPENT = 'https://rpc-spent.example.org';

/** Answers normally. */
const live: RpcTransport = (async () => ({
  jsonrpc: '2.0',
  id: 1,
  result: 123_456_789n,
})) as unknown as RpcTransport;

/** HTTP 200, JSON-RPC error body — what a spent quota actually returns. */
const spent: RpcTransport = (async () => ({
  jsonrpc: '2.0',
  id: 1,
  error: { code: -32429, message: 'max usage reached' },
})) as unknown as RpcTransport;

function poolOver(transports: Record<string, RpcTransport>) {
  return new CovanticRpcPool({
    primaryUrl: LIVE,
    fallbackUrls: SPENT,
    transportFactory: (url) => transports[url]!,
    probeSlots: true,
  });
}

async function settle(): Promise<void> {
  // The probe fires once on construction and is not awaited.
  await new Promise((r) => setTimeout(r, 20));
}

describe('INV-POOL-01 — a quota error is not a healthy answer', () => {
  it('does not report an endpoint that only ever returned an error as healthy', async () => {
    const pool = poolOver({ [LIVE]: live, [SPENT]: spent });
    await settle();

    const status = pool.status();
    const dead = status.endpoints.find((e) => e.name.includes('rpc-spent'));

    expect(dead?.healthy).toBe(false);
    expect(dead?.unverified).toBe(true);
    pool.stop();
  });

  it('still reports the endpoint that answered as healthy', async () => {
    // The guard must not swallow the working half: a rule that marked
    // everything unverified would be as useless as the optimism it replaces.
    const pool = poolOver({ [LIVE]: live, [SPENT]: spent });
    await settle();

    const ok = pool.status().endpoints.find((e) => e.name.includes('rpc-live'));

    expect(ok?.healthy).toBe(true);
    expect(ok?.unverified).toBe(false);
    pool.stop();
  });

  it('separates "never worked" from "worked and stopped"', async () => {
    // `ejected` is a cooldown on an endpoint that had been serving. An
    // endpoint that has never answered is a different operational condition —
    // a spent quota, a bad credential, a host that is not there — and it does
    // not clear itself by waiting.
    const pool = poolOver({ [LIVE]: live, [SPENT]: spent });
    await settle();

    const dead = pool.status().endpoints.find((e) => e.name.includes('rpc-spent'));

    expect(dead?.unverified).toBe(true);
    expect(dead?.ejected).toBe(false);
    pool.stop();
  });
});
