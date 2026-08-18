import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialisation: object keys sorted recursively, no
 * whitespace, `undefined` members dropped.
 *
 * Two bundles carrying the same evidence must produce the same bytes
 * regardless of the order fields happened to be assigned in. Otherwise the
 * hash commits to insertion order rather than to content, and every replay
 * disagrees with the original.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = sortDeep(v);
  return out;
}

/** sha256 of the canonical form, hex-encoded. */
export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** Fields describing when we looked rather than what we found. Excluded from
 *  the hash so replaying the same evidence hashes identically. */
const PROVENANCE_FIELDS = new Set(['collectedAt', 'stage']);

/**
 * Hash of an evidence bundle's content, ignoring provenance fields.
 * This is the value committed on-chain in Phase 6 — anyone holding the
 * published bundle can recompute it and check the commitment.
 */
export function bundleHash(bundle: Record<string, unknown>): string {
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bundle)) {
    if (!PROVENANCE_FIELDS.has(k)) content[k] = v;
  }
  return sha256Canonical(content);
}

/** Hash binding a verdict to the exact evidence it was derived from. */
export function verdictHash(bundleHashHex: string, verdict: unknown): string {
  return createHash('sha256')
    .update(bundleHashHex, 'utf8')
    .update(' ', 'utf8')
    .update(canonicalize(verdict), 'utf8')
    .digest('hex');
}
