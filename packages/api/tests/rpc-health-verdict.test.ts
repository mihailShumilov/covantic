import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-HEALTH-01 — running on the last endpoint is not "ok".
 *
 * The verdict had two states: some endpoint answers, or none does. So a pool
 * that had lost every endpoint but one reported green — the shape of the whole
 * incident behind this: a vendor's quota ran out, webhooks stopped, the
 * fallback endpoint was ejected, and every health surface stayed green for six
 * hours. The pool knew. Nothing it reported said so.
 *
 * The obvious correction — `ok` only when every configured endpoint is usable —
 * is wrong for a different reason. A deployment that keeps a known-bad endpoint
 * configured because its quota resets next week would sit in `degraded` for a
 * week, and a status that is always on says nothing at all.
 *
 * **Two** is the number that carries meaning here, and it is a property of this
 * codebase rather than a convention. `fetchAnchorAccount(…, { corroborate:
 * true })` reads a holder's declaration from two endpoints and requires them to
 * agree; with one endpoint it degrades — deliberately, and silently — to that
 * endpoint's word. Those are the reads that *close* claims, and wrongful denial
 * is the loss this product exists to prevent.
 *
 * `degraded` stays distinct from `no-endpoint-available`: settlement still
 * works on one endpoint, and paging as though it had stopped teaches an
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

  it('draws the line at two, which is what corroboration needs', () => {
    // Not `usable < configured`: that would pin a deployment holding a
    // known-bad endpoint to `degraded` indefinitely. The threshold has to be
    // the one below which `corroborate: true` stops corroborating.
    expect(source).toMatch(/usable === 0/);
    expect(source).toMatch(/usable < 2/);
    expect(source).not.toMatch(/usable < status\.endpoints\.length/);
  });

  it('keeps the counts, so a dead configured endpoint is still visible', () => {
    // The verdict stops crying wolf; the numbers still say one endpoint is
    // down. An operator reads the condition from those.
    expect(source).toMatch(/endpointsHealthy: usable/);
    expect(source).toMatch(/endpointsConfigured: status\.endpoints\.length/);
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
