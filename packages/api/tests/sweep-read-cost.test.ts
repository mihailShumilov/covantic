import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-COST-01 — a sweep that finds nothing costs almost nothing.
 *
 * `EXPLOIT_SWEEP_INTERVAL_MS` goes down to five seconds, and on a demo build
 * it is set there deliberately. Every read the sweep performs unconditionally
 * is therefore multiplied by twelve per minute per agent — and the mandate is
 * read with `corroborate: true`, which is two endpoint reads, not one.
 *
 * Reading it on every tick took production down. With the fallback endpoint
 * ejected on its own quota, the public RPC answered 334 `Too Many Requests` in
 * forty minutes, and once it did, *every* read failed — including the ones
 * that decide claims. A real, correctly detected mandate breach was settled as
 * a rejected exploit because the mandate could not be read at the moment the
 * verifier asked for it.
 *
 * The rule this encodes: the sweep's cost must be proportional to what
 * happened, not to how often it looks. Almost every sweep has nothing new to
 * screen, and a lookup only needed to judge a candidate belongs behind the
 * check for one.
 */

const WATCHER = fileURLToPath(new URL('../src/workers/exploit-watcher.ts', import.meta.url));

describe('INV-COST-01 — per-agent lookups stay behind the candidate check', () => {
  it('reads the mandate lazily rather than once per tick', () => {
    const source = readFileSync(WATCHER, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    // The lazy accessor must exist and be what the screen calls.
    expect(source).toMatch(/const mandateFor = async \(\)/);
    expect(source).toMatch(/await mandateFor\(\)/);

    // And the eager call must not come back: `readMandateFor` is reachable
    // only through the accessor.
    const directCalls = [...source.matchAll(/await readMandateFor\(/g)].length;
    expect(directCalls, 'call readMandateFor only from the lazy accessor').toBe(1);
  });

  it('resolves the mandate inside the transaction loop, not before it', () => {
    const source = readFileSync(WATCHER, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const loopAt = source.indexOf('for (const tx of txs)');
    const resolveAt = source.indexOf('await mandateFor()');

    expect(loopAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(loopAt);
  });
});
