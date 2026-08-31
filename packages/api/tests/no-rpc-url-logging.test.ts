import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-SECRET-01 — an RPC URL never reaches an output stream.
 *
 * `config/rpc-pool.ts` states it: "**URLs are never logged.** Provider API
 * keys live in the query string." The pool honours it rigorously — and the
 * first script written *after* the sentence was added printed
 * `SOLANA_RPC_URL` verbatim, key included, on a host where the runbook tells
 * an operator to run it.
 *
 * That is the shape of invariant that needs a test rather than a sentence: it
 * is violated by a one-line `console.log` in a file nobody thinks of as
 * security-relevant, and the damage — a leaked provider key, an exhausted
 * quota, and a service that stops checkpointing — arrives much later and looks
 * like an unrelated outage.
 *
 * `rpcEndpointName()` exists precisely so a script can print something useful.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Identifiers that hold a full RPC URL, credential and all. */
const URL_BEARING = /\b(rpcUrl|SOLANA_RPC_URL|SOLANA_RPC_FALLBACK_URLS|SOLANA_ARCHIVE_RPC_URL)\b/;

/** Anything that writes to a stream a human or a log pipeline reads. */
const EMITS = /\b(console\.(log|info|warn|error|debug)|logger\.(info|warn|error|debug|trace))\s*\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) sourceFiles(`${path}/`, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('INV-SECRET-01 — no RPC URL reaches a log line', () => {
  it('emits the endpoint host, never the URL', () => {
    const offenders: string[] = [];

    for (const dir of ['src/', 'scripts/']) {
      for (const file of sourceFiles(`${ROOT}${dir}`)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('*') || code.startsWith('//')) return;
          if (!EMITS.test(code) || !URL_BEARING.test(code)) return;
          // `rpcEndpointName(url)` reduces to `new URL(url).host`, which drops
          // the query string the key lives in.
          if (/rpcEndpointName\s*\(/.test(code)) return;
          offenders.push(`${file.slice(ROOT.length)}:${i + 1} — ${code.slice(0, 90)}`);
        });
      }
    }

    expect(offenders, 'wrap these in rpcEndpointName() before logging').toEqual([]);
  });
});
