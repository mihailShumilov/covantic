import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-HEALTH-01 — running on the last endpoint is not "ok".
 *
 * The verdict had two states: some endpoint answers, or none does. So a pool
 * that had lost every endpoint but one reported green — and a single endpoint
 * is not a pool. It is the single point of failure the pool exists to remove,
 * and it is also the state in which `getAccountInfoCorroborated` has nothing
 * to compare against, so the reads that can *close* a claim fall back to one
 * endpoint's word.
 *
 * This is the shape of the whole incident behind it: a vendor's quota ran out,
 * webhooks stopped, the fallback endpoint was ejected, and every health surface
 * stayed green for six hours. The pool knew. Nothing it reported said so.
 *
 * `degraded` is deliberately distinct from `no-endpoint-available`. Settlement
 * still works on one endpoint; paging as though it had stopped teaches an
 * operator to ignore the page that means it actually has.
 */

const ROUTE = fileURLToPath(new URL('../src/routes/health.ts', import.meta.url));

describe('INV-HEALTH-01 — the RPC verdict distinguishes degraded from ok', () => {
  const source = readFileSync(ROUTE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('has a degraded state between ok and no-endpoint-available', () => {
    expect(source).toMatch(/'no-endpoint-available'/);
    expect(source).toMatch(/'degraded'/);
    expect(source).toMatch(/'ok'/);
  });

  it('reserves ok for a pool with every endpoint usable', () => {
    // The comparison is what carries it: `usable === 0` is the outage,
    // `usable < configured` is the degradation, and only equality is `ok`.
    expect(source).toMatch(/usable === 0/);
    expect(source).toMatch(/usable < status\.endpoints\.length/);
  });

  it('counts an endpoint in cooldown as unusable, not as present', () => {
    // An ejected endpoint is configured and not answering. Counting it as
    // healthy is exactly the arithmetic that produced the green status.
    expect(source).toMatch(/e\.healthy && e\.cooldownSec === 0/);
  });

  it('still answers 200, so a poller does not read it as the API being down', () => {
    expect(source).not.toMatch(/reply\.code\(5\d\d\)/);
  });
});
