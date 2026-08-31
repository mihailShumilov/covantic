import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-THREE-01 — an unreadable declaration does not finalise a rejection.
 *
 * The discipline is stated in CLAUDE.md and holds everywhere else: "An
 * unavailable price source, an unindexed trigger tx, or references that
 * disagree must produce `indeterminate` — never `rejected`. Closing a claim is
 * a statement that the evidence contradicts it."
 *
 * `reattributeToAgentError` broke it in one place, and the break was invisible
 * because both outcomes were `false`. An exploit verdict of
 * `agent_authorized_movement` is the agent-error path's opening statement, so
 * the keeper reads the holder's mandate to decide whether to re-file. A
 * mandate that was *read* and is absent or immature is a real answer — there
 * is nothing to measure against, and the exploit rejection carries more
 * information than a second "we cannot tell". A mandate nobody could *fetch*
 * is not that answer. It was returned identically, and the rejection stood.
 *
 * This is not hypothetical. When the sweep exhausted the RPC's rate limit, a
 * correctly detected mandate breach was closed as a rejected exploit — the
 * verdict resting on a declaration that existed, had matured, and simply could
 * not be read at that moment.
 */

const KEEPER = fileURLToPath(new URL('../src/workers/claim-keeper.ts', import.meta.url));

describe('INV-THREE-01 — the two ways of having no mandate stay distinct', () => {
  it('reports an unreadable mandate separately from an absent one', () => {
    const source = readFileSync(KEEPER, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    // A boolean cannot carry the distinction, which is how it was lost.
    expect(source).toMatch(/Promise<'reattributed' \| 'unreadable' \| 'no'>/);
    expect(source).toMatch(/return 'unreadable';/);
    expect(source).toMatch(/return 'no';/);
  });

  it('retries on unreadable instead of letting the rejection close the claim', () => {
    const source = readFileSync(KEEPER, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const branchAt = source.indexOf("reattribution === 'unreadable'");
    // The branch body ends where the ordinary indeterminate check begins.
    // Slicing to the *rejection* path instead swallows that check — which also
    // calls `handleIndeterminate` — and the assertion below would then pass no
    // matter what this branch did. It did, until a mutation run caught it.
    const branchEnd = source.indexOf("if (result.outcome === 'indeterminate')");
    const rejectAt = source.indexOf("if (result.outcome === 'rejected'");

    expect(branchAt).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchAt);
    // The branch has to come before the rejection path, or it decides nothing.
    expect(branchAt).toBeLessThan(rejectAt);
    // And it must route to the retry handler, not to review directly: an RPC
    // that is rate-limited now usually answers a minute later, and going
    // straight to a human would spend the escalation on a blip.
    expect(source.slice(branchAt, branchEnd)).toMatch(/handleIndeterminate\(/);
  });

  it('names the reason, so the trail says what was missing', () => {
    const source = readFileSync(KEEPER, 'utf8');

    expect(source).toContain('mandate_unreadable_during_reattribution');
  });
});
