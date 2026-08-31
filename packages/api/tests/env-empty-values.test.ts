import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-ENV-01 — every variable compose can pass empty is accepted empty.
 *
 * `docker-compose.prod.yml` has no `env_file`, so each optional variable is
 * threaded explicitly as `${VAR:-}`. An operator who has not set one therefore
 * gets `''` in the container, not `undefined` — and `''` satisfies neither
 * `.optional()` nor `.min(n)`.
 *
 * This has now bitten twice. `USDC_MINT` first, where a preprocessor mapped any
 * short value to `undefined` and silently disabled the agent-error claim path.
 * Then `HELIUS_WEBHOOK_BEARER`, added to the compose block without the guard,
 * which put the api and monitor containers into a restart loop on deploy
 * because a bearer nobody had set failed `.min(32)`.
 *
 * The failure mode is what makes it worth a test rather than a convention: it
 * is invisible locally — a developer's `.env` either sets the variable or omits
 * the line entirely, and omitting it gives `undefined`, which passes. Only the
 * compose path produces the empty string, so only production sees it.
 */

const COMPOSE = fileURLToPath(new URL('../../../docker/docker-compose.prod.yml', import.meta.url));
const ENV_SCHEMA = fileURLToPath(new URL('../src/config/env.ts', import.meta.url));

/** Variables compose passes with an empty default: `VAR: ${VAR:-}`. */
function emptyDefaulted(): string[] {
  const text = readFileSync(COMPOSE, 'utf8');
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^\s+([A-Z_][A-Z0-9_]*):\s*\$\{([A-Z_][A-Z0-9_]*):-\}\s*$/.exec(line);
    if (m) found.add(m[1]!);
  }
  return [...found].sort();
}

describe('INV-ENV-01 — an unset compose variable arrives as an empty string', () => {
  it('guards every empty-defaulted variable the schema validates', () => {
    const schema = readFileSync(ENV_SCHEMA, 'utf8');
    const unguarded: string[] = [];

    for (const name of emptyDefaulted()) {
      // Variables the schema does not mention are read straight from
      // `process.env` by whoever needs them; those are the caller's problem
      // and are covered by their own guard (see `FLEET_SINK_ADDRESS` in
      // `scripts/fleet-start.ts`).
      const declared = new RegExp(`^\\s+${name}:`, 'm').exec(schema);
      if (!declared) continue;

      // The declaration runs from its name to the next top-level key.
      const rest = schema.slice(declared.index + declared[0].length);
      const end = /\n {2}[A-Z_][A-Z0-9_]*:/.exec(rest);
      const body = rest.slice(0, end ? end.index : 400);

      // Either it maps empty to undefined, or it imposes no constraint an
      // empty string could fail.
      const guarded = /optionalEnv\(|preprocess\(/.test(body);
      const constrained = /\.min\(|\.url\(|\.uuid\(|\.regex\(|z\.enum\(/.test(body);
      if (!guarded && constrained) unguarded.push(name);
    }

    expect(
      unguarded,
      'wrap these in optionalEnv() — compose passes them as "" when unset',
    ).toEqual([]);
  });

  it('finds the compose variables at all, so a rename cannot make this vacuous', () => {
    // A test that silently checks nothing is worse than no test: if the
    // compose format changes and the regex stops matching, this fails rather
    // than passing on an empty set.
    expect(emptyDefaulted().length).toBeGreaterThan(0);
  });
});
