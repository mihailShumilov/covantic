import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../src/config/env.js';

/**
 * INV-ENV-01 — every variable compose can pass empty is accepted empty.
 *
 * `docker-compose.prod.yml` has no `env_file`, so each optional variable is
 * threaded explicitly as `${VAR:-}`. An operator who has not set one therefore
 * gets `''` in the container, not `undefined` — and `''` satisfies neither
 * `.optional()` nor `.min(n)`.
 *
 * This has now bitten three times. `USDC_MINT` first, where a preprocessor
 * mapped any short value to `undefined` and silently disabled the agent-error
 * claim path. Then `HELIUS_WEBHOOK_BEARER`, added to the compose block without
 * the guard, which put the api and monitor containers into a restart loop on
 * deploy because a bearer nobody had set failed `.min(32)`. Then
 * `EXPLOIT_LOCK_SECONDS`, which was the mirror image: added to `.env` and to
 * the schema but never to the compose block, so the containers ran on the
 * default and the setting an operator had written was inert.
 *
 * A crash loop is the *survivable* half of this. `z.coerce.number()` turns `''`
 * into `0` — a valid number, no error — so an unset
 * `AUTO_PAYOUT_HOURLY_LIMIT_RAW` would have set the hourly payout breaker to
 * zero and refused every payout, with nothing in the logs to say why.
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

/**
 * A minimal environment that satisfies the schema, for the empty-value cases
 * to vary one field at a time against.
 *
 * Hand-written rather than read from `.env.example`, because the example file
 * carries placeholders — `PROGRAM_ID`, `WEBHOOK_PUBLIC_URL` — that the schema
 * correctly rejects. `parses on its own` below is the coverage check: add a
 * required variable to the schema without adding it here and it fails.
 */
const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://covantic:pw@localhost:5432/covantic',
  REDIS_URL: 'redis://localhost:6379',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  PROGRAM_ID: 'HrLqdNdxUJq4pgsL4NsUqzfYrGxR7Hy9PHGEeHnj3skL',
  ORACLE_KEYPAIR_PATH: '/app/keys/oracle-keypair.json',
  HELIUS_API_KEY: 'helius-key',
  HELIUS_WEBHOOK_SECRET: 'x'.repeat(64),
  ALERT_HMAC_SECRET: 'y'.repeat(32),
};

function requiredValues(): Record<string, string> {
  return { ...BASE };
}

describe('INV-ENV-01 — an unset compose variable arrives as an empty string', () => {
  it('parses on its own, so the fixture cannot fall behind the schema', () => {
    const parsed = envSchema.safeParse(requiredValues());

    expect(
      parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => String(i.path[0])))],
      'add these to BASE',
    ).toEqual([]);
  });

  it('accepts an empty string for every variable compose can pass empty', () => {
    // Parsed, not pattern-matched. The previous version of this test read the
    // schema source and looked for `optionalEnv(`, which confirmed the fix was
    // *present* rather than that it *worked* — and
    // `optionalEnv(schema).default(x)` is present, reads naturally, and is
    // wrong: `.default()` outside the call wraps the preprocessor, substitutes
    // only for `undefined`, and so passes `''` through to a coercion that
    // yields `NaN`. That shipped, and the api and monitor crash-looped on it.
    const base = requiredValues();
    const failures: string[] = [];

    for (const name of emptyDefaulted()) {
      if (!(name in envSchema.shape)) continue;
      const parsed = envSchema.safeParse({ ...base, [name]: '' });
      if (!parsed.success) {
        const issue = parsed.error.issues.find((i) => i.path[0] === name);
        if (issue) failures.push(`${name}: ${issue.message}`);
      }
    }

    expect(
      failures,
      'wrap these in optionalEnv(schema.default(x)) — compose passes them as "" when unset',
    ).toEqual([]);
  });

  it('falls back to the default rather than to NaN', () => {
    // The specific shape of the bug. `''` must reach the *default*, not merely
    // avoid an error: a limit that silently became 0 or NaN is worse than one
    // that refuses to start, because the service comes up and misbehaves.
    const parsed = envSchema.parse({ ...requiredValues(), AUTO_PAYOUT_HOURLY_LIMIT_RAW: '' });

    expect(parsed.AUTO_PAYOUT_HOURLY_LIMIT_RAW).toBe(100_000_000_000);
    expect(Number.isNaN(parsed.AUTO_PAYOUT_HOURLY_LIMIT_RAW)).toBe(false);
  });

  it('still reads a value an operator did set', () => {
    // The guard must not swallow real input — a preprocessor that returned
    // `undefined` unconditionally would pass every assertion above.
    const parsed = envSchema.parse({ ...requiredValues(), EXPLOIT_LOCK_SECONDS: '30' });

    expect(parsed.EXPLOIT_LOCK_SECONDS).toBe(30);
  });

  it('threads every documented variable the schema reads into both services', () => {
    // The mirror failure: a variable in `.env.example` and in the schema, but
    // absent from the compose block, cannot be set at all. `.env` accepts the
    // line, `docker compose config` reports nothing, and the container runs on
    // the default — which is how `EXPLOIT_LOCK_SECONDS=30` reached a server
    // that went on waiting an hour, and how a tuned `AUTO_PAYOUT_HOURLY_LIMIT_RAW`
    // would have been silently ignored.
    const compose = readFileSync(COMPOSE, 'utf8');
    const schema = readFileSync(ENV_SCHEMA, 'utf8');
    const example = readFileSync(
      fileURLToPath(new URL('../../../.env.example', import.meta.url)),
      'utf8',
    );

    // Variables only a host-side CLI reads never enter a container.
    const HOST_ONLY = new Set([
      // `pnpm webhook:sync`, run from the repo on the host.
      'WEBHOOK_PUBLIC_URL',
    ]);

    const documented = new Set(
      [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
    );
    const declared = [...schema.matchAll(/^  ([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);

    const unreachable = declared
      .filter((name) => documented.has(name) && !HOST_ONLY.has(name))
      // Present anywhere in an environment block, however its value is built:
      // `DATABASE_URL` is assembled from parts rather than passed through.
      .filter((name) => !new RegExp(`^\\s+${name}:`, 'm').test(compose))
      .sort();

    expect(
      unreachable,
      'add these to the api and monitor environment blocks — an operator cannot set them otherwise',
    ).toEqual([]);
  });

  it('finds the compose variables at all, so a rename cannot make this vacuous', () => {
    // A test that silently checks nothing is worse than no test: if the
    // compose format changes and the regex stops matching, this fails rather
    // than passing on an empty set.
    expect(emptyDefaulted().length).toBeGreaterThan(0);
  });
});
