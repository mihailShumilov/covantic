import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-POOL-01 — every chain read is on the endpoint pool, except the ones
 * that are written down.
 *
 * `CLAUDE.md` states the rule and names its exception:
 *
 *   > Anchor account reads go through `utils/anchor-reader.ts` … with **one
 *   > deliberate exception**: a read that asks whether *our own* write landed
 *   > (`isPolicySettledOnChain`, the `ClaimPending` rescue in the keeper,
 *   > `AttestationPublisher.fetchExisting`) stays on the connection we wrote
 *   > from … Every site carries a comment saying so.
 *
 * That sentence is a claim about the whole source tree, so it is checkable
 * exhaustively rather than sampled — and the check is worth having because the
 * failure it guards has no runtime symptom until a provider is down, which is
 * the one moment the system needs to work. `program.account.X.fetch()` goes
 * through the Anchor provider's single `Connection`; when that endpoint is
 * over quota the call throws, and for the four proof posters it throws *after*
 * a claim has been verified and immediately before the payout instruction.
 *
 * The list below is what the tree actually contains, split into the sites the
 * documentation accounts for and the ones it does not. It is a ratchet: a new
 * off-pool read fails this test, and moving one onto the pool fails it too, so
 * neither can happen silently.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Anchor account reads. `Promise.all` is not one of them. */
const READ_CALL = /(?<![A-Za-z])(?:fetchNullable|fetch|all)\s*\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) sourceFiles(`${path}/`, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Every line in `src/` that reads an Anchor account off the program namespace.
 *
 * Deliberately textual. The alternative — a runtime probe — cannot see a call
 * site that no test exercises, and the sites that matter here are exactly the
 * ones only reached during a settlement.
 */
function offPoolAnchorReads(): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const relative = file.slice(SRC.length);
    // The pool's own implementation is where these calls are supposed to live.
    if (relative === 'utils/anchor-reader.ts') continue;

    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
      if (!READ_CALL.test(code)) return;
      if (/Promise\s*\.\s*all\s*\(/.test(code)) return;
      // The namespace is reached either directly or through a local alias
      // (`const accounts = ctx.program.account as …`), so both spellings count.
      // The namespace can sit two lines up: `(ctx.program.account as any)\n
      // .insurancePolicy\n .fetchNullable(policy)` is one expression across
      // three lines, and the keeper's `ClaimPending` rescue is written that way.
      const context = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
      if (!/program\.account|\baccounts\s*\.|accountNamespace\./.test(context)) return;
      hits.push(`${relative}:${i + 1}`);
    });
  }
  return hits.sort();
}

/**
 * The sites `CLAUDE.md` names, as file → number of reads. Each asks "did our
 * own write land?", and an endpoint a few slots behind would answer no about a
 * transaction that succeeded — turning a completed payout into a retry, or
 * picking `init` for a PDA that already exists.
 *
 * Counted per file rather than pinned to line numbers: a line number is a
 * ratchet against unrelated edits, not against drift, and the first ordinary
 * change to `claim-keeper.ts` made this test fail for a reason that had
 * nothing to do with the invariant.
 */
const DOCUMENTED_EXCEPTIONS: Record<string, number> = {
  'services/attestation-publisher.ts': 1, // AttestationPublisher.fetchExisting
  // isPolicySettledOnChain, the ClaimPending rescue, and claimSubmittedAtOnChain.
  //
  // The third joined the list deliberately. The program starts every lock from
  // `claim_submitted_at`, which it writes when the submit lands; scheduling the
  // payout off a locally-computed expiry fired early by the submit latency on
  // every claim. Reading that field back is the same question the other two
  // ask — did our own write land, and when — so it belongs on the connection
  // we wrote from, for the same reason: a lagging endpoint would report no
  // claim at all and the timer would fall back to the figure being corrected.
  'workers/claim-keeper.ts': 3,
};

describe('INV-POOL-01 — Anchor reads off the endpoint pool are enumerated', () => {
  it('finds exactly the documented exceptions, and no other', () => {
    // Fails in both directions on purpose: a new off-pool read is drift, and
    // migrating one is a change to this list that someone has to make.
    const byFile: Record<string, number> = {};
    for (const hit of offPoolAnchorReads()) {
      const file = hit.slice(0, hit.lastIndexOf(':'));
      byFile[file] = (byFile[file] ?? 0) + 1;
    }

    expect(byFile).toEqual(DOCUMENTED_EXCEPTIONS);
  });

  it('has a comment at every off-pool read saying why', () => {
    // `CLAUDE.md`: "Every site carries a comment saying so." This is the half
    // of the invariant that decays first — a read migrates, the comment stays,
    // or a new read arrives with no comment and nobody notices.
    for (const site of offPoolAnchorReads()) {
      const line = Number(site.slice(site.lastIndexOf(':') + 1));
      const file = site.slice(0, site.lastIndexOf(':'));
      const lines = readFileSync(`${SRC}${file}`, 'utf8').split('\n');
      const preceding = lines.slice(Math.max(0, line - 15), line - 1).join(' ');

      expect(preceding, `${site} has no comment explaining why it is off the pool`).toMatch(
        /read pool|our own|provider's own connection|provider's connection/i,
      );
    }
  });

  it('keeps the four proof posters and both checkpoint writers on the pool', () => {
    // The reads with teeth: a proof poster's config read runs after a claim is
    // verified and immediately before the payout instruction, so on the
    // provider's own connection a quota outage stalled settlement on every
    // proven path — the exact failure the pool was introduced to remove.
    const offPool = offPoolAnchorReads().join(' ');

    for (const file of [
      'services/exploit/proof-poster.ts',
      'services/oracle/proof-poster.ts',
      'services/governance/proof-poster.ts',
      'services/agent-error/proof-poster.ts',
      'services/exploit/checkpoint.ts',
      'services/governance/checkpoint.ts',
    ]) {
      expect(offPool, `${file} must read through the pool`).not.toContain(file);
    }
  });
});
