import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * INV-HISTORY-01 — the agent's own history is written from the chain too.
 *
 * `recordOutflow`'s contract says it plainly: "Both the webhook monitor and
 * the watcher sweep call this, so the write is idempotent on
 * `(agent, signature, mint)`." Only the monitor did. The sentence described an
 * intention, and nothing checked it.
 *
 * The consequence is not cosmetic. `outflowBaseline` is the corroboration
 * `scoreConfidence` reads, and its absence is a standing −0.03 on every
 * agent-error verdict. Combined with the unevaluated dimensions of a sparse
 * declaration that is enough to hold a *correctly confirmed* breach below
 * `REVIEW_CONFIDENCE` — permanently, since no later run can invent the history
 * that was never written. A claim the chain would settle sat in review because
 * nobody had recorded what the agent normally does.
 *
 * A file-level check rather than a behavioural one, deliberately: the defect
 * is a missing call site, and a test that exercises the sweep would have to
 * stand up Postgres, Redis, an Anchor provider and an RPC pool to observe the
 * absence of one insert.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Every producer that sees an agent's transactions must feed the baseline. */
const PRODUCERS = [
  // The push path: Helius delivers, the monitor screens.
  'src/services/transaction-monitor.ts',
  // The pull path: the sweep reads the chain itself. This is the one that was
  // missing, and it is the one that still works when a vendor stops answering.
  'src/workers/exploit-watcher.ts',
];

describe('INV-HISTORY-01 — both transaction sources record what left the agent', () => {
  it('calls recordOutflow from every producer', () => {
    const missing = PRODUCERS.filter(
      (file) => !/\brecordOutflow\s*\(/.test(readFileSync(`${ROOT}${file}`, 'utf8')),
    );

    expect(
      missing,
      'a producer that sees transactions but does not record them leaves the baseline blind',
    ).toEqual([]);
  });

  it('records before screening, so ordinary movements are in the distribution', () => {
    // A baseline built only from flagged transactions describes the exceptions
    // and then calls them the norm — which inverts the "far above this agent's
    // history" signal it exists to supply.
    const sweep = readFileSync(`${ROOT}src/workers/exploit-watcher.ts`, 'utf8');
    const recordAt = sweep.indexOf('await recordOutflows(');
    const firstScreenAt = sweep.indexOf('screenRawTxForGovernance(');

    expect(recordAt).toBeGreaterThan(-1);
    expect(firstScreenAt).toBeGreaterThan(-1);
    expect(recordAt).toBeLessThan(firstScreenAt);
  });
});
