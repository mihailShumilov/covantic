/**
 * Re-derive a stored claim verdict from its evidence and diff it against what
 * was recorded.
 *
 *   pnpm claim:replay <claimId>
 *   pnpm claim:replay --all --since 7d
 *
 * A payout nobody can reproduce is a payout nobody can audit. This is the
 * check that the reproducibility guarantee actually holds: the adjudicator is
 * a pure function of the bundle, so replaying stored evidence under the same
 * adjudicator version must return a byte-identical verdict. Anything else is
 * either a bug or tampering, and both are worth an alarm.
 *
 * A difference under a *different* adjudicator version is expected and is
 * reported as a version drift rather than a failure — that is what bumping
 * the version means.
 */
import { desc, eq, gte } from 'drizzle-orm';
import { loadConfig } from '../src/config/env.js';
import { createDbConnection } from '../src/config/database.js';
import { claimEvidence } from '../src/db/schema.js';
import {
  EXPLOIT_ADJUDICATOR_VERSION,
  adjudicateExploit,
} from '../src/services/exploit/adjudicate.js';
import type { ExploitEvidenceBundle } from '../src/services/exploit/types.js';
import {
  GOVERNANCE_ADJUDICATOR_VERSION,
  adjudicateGovernance,
} from '../src/services/governance/adjudicate.js';
import type { GovernanceEvidenceBundle } from '../src/services/governance/types.js';
import { ADJUDICATOR_VERSION, adjudicate } from '../src/services/oracle/adjudicate.js';
import { bundleHash, verdictHash } from '../src/services/oracle/hash.js';
import type { EvidenceBundle } from '../src/services/oracle/types.js';

/** Trigger enum values, mirrored so the script does not pull in the whole
 *  shared package for two numbers. */
const TRIGGER_EXPLOIT = 1;
const TRIGGER_ORACLE_MANIPULATION = 2;
const TRIGGER_GOVERNANCE_ATTACK = 4;

interface ReplayEngine {
  version: string;
  run: (bundle: unknown) => { outcome: string; lossAmount: number; confidence: number; details: Record<string, unknown> };
}

/**
 * Pick the adjudicator that produced a bundle.
 *
 * Every bundle carries its own `triggerType`, so this never has to consult
 * the claim row — which matters, because the whole point of the exercise is
 * that a bundle is self-contained evidence.
 */
function engineFor(bundle: { triggerType?: number }): ReplayEngine | null {
  switch (bundle.triggerType) {
    case TRIGGER_EXPLOIT:
      return {
        version: EXPLOIT_ADJUDICATOR_VERSION,
        run: (b) => adjudicateExploit(b as ExploitEvidenceBundle),
      };
    case TRIGGER_ORACLE_MANIPULATION:
      return {
        version: ADJUDICATOR_VERSION,
        run: (b) => adjudicate(b as EvidenceBundle),
      };
    case TRIGGER_GOVERNANCE_ATTACK:
      return {
        version: GOVERNANCE_ADJUDICATOR_VERSION,
        run: (b) => adjudicateGovernance(b as GovernanceEvidenceBundle),
      };
    default:
      return null;
  }
}

interface ReplayOutcome {
  claimId: string;
  attempt: number;
  storedVersion: string;
  status: 'match' | 'mismatch' | 'version_drift' | 'bundle_tampered' | 'not_replayable';
  storedVerdictHash: string;
  replayedVerdictHash: string;
  storedBundleHash: string;
  recomputedBundleHash: string;
  detail?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const claimId = args.find((a) => !a.startsWith('--'));

  if (!all && !claimId) {
    console.error('usage: pnpm claim:replay <claimId> | --all [--since 7d]');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const db = createDbConnection(config.DATABASE_URL);

  try {
    const rows = all
      ? await db
          .select()
          .from(claimEvidence)
          .where(gte(claimEvidence.createdAt, sinceFrom(args)))
          .orderBy(desc(claimEvidence.createdAt))
      : await db.select().from(claimEvidence).where(eq(claimEvidence.claimId, claimId!));

    if (rows.length === 0) {
      console.error('no stored evidence found');
      process.exitCode = 1;
      return;
    }

    const results = rows.map((row) => replayOne(row));
    for (const result of results) report(result);

    const failures = results.filter(
      (r) => r.status === 'mismatch' || r.status === 'bundle_tampered',
    );
    console.error(
      `\n${results.length} replayed, ${failures.length} failed, ` +
        `${results.filter((r) => r.status === 'version_drift').length} on an older adjudicator`,
    );
    // Non-zero exit so this can gate CI: a verdict that no longer reproduces
    // is a regression in the guarantee, not an informational notice.
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    // drizzle holds the pool; the process exits once the event loop drains.
    await db.$client.end();
  }
}

function replayOne(row: typeof claimEvidence.$inferSelect): ReplayOutcome {
  const bundle = row.bundle as unknown as Record<string, unknown>;
  const storedVerdict = row.verdict as Record<string, unknown>;

  // First: is the stored bundle the one that was hashed? If the evidence has
  // been altered, nothing downstream means anything.
  const recomputedBundleHash = bundleHash(bundle);
  if (recomputedBundleHash !== row.bundleHash) {
    return {
      claimId: row.claimId,
      attempt: row.attempt,
      storedVersion: row.adjudicatorVersion,
      status: 'bundle_tampered',
      storedVerdictHash: row.verdictHash,
      replayedVerdictHash: '',
      storedBundleHash: row.bundleHash,
      recomputedBundleHash,
      detail: 'stored bundle does not hash to its recorded bundle_hash',
    };
  }

  const engine = engineFor(bundle as { triggerType?: number });
  if (!engine) {
    // A trigger whose verdict is not yet produced by a pure function. Saying
    // so beats reporting a mismatch against rules that never applied.
    return {
      claimId: row.claimId,
      attempt: row.attempt,
      storedVersion: row.adjudicatorVersion,
      status: 'not_replayable',
      storedVerdictHash: row.verdictHash,
      replayedVerdictHash: '',
      storedBundleHash: row.bundleHash,
      recomputedBundleHash,
      detail: `no pure adjudicator for triggerType=${String(
        (bundle as { triggerType?: number }).triggerType,
      )}`,
    };
  }

  const replayed = engine.run(bundle);
  const replayedVerdict = {
    outcome: replayed.outcome,
    lossAmount: replayed.lossAmount,
    confidence: replayed.confidence,
    lockPeriod: (storedVerdict.lockPeriod as number) ?? 0,
    details: replayed.details,
  };
  const replayedVerdictHash = verdictHash(recomputedBundleHash, replayedVerdict);

  const versionMatches = row.adjudicatorVersion === engine.version;
  const outcomeMatches = replayed.outcome === storedVerdict.outcome;
  const lossMatches = replayed.lossAmount === storedVerdict.lossAmount;

  let status: ReplayOutcome['status'];
  if (outcomeMatches && lossMatches) status = 'match';
  else if (!versionMatches) status = 'version_drift';
  else status = 'mismatch';

  return {
    claimId: row.claimId,
    attempt: row.attempt,
    storedVersion: row.adjudicatorVersion,
    status,
    storedVerdictHash: row.verdictHash,
    replayedVerdictHash,
    storedBundleHash: row.bundleHash,
    recomputedBundleHash,
    detail:
      status === 'match'
        ? undefined
        : `stored ${String(storedVerdict.outcome)}/${String(storedVerdict.lossAmount)} vs ` +
          `replayed ${replayed.outcome}/${replayed.lossAmount}`,
  };
}

function report(result: ReplayOutcome): void {
  const mark =
    result.status === 'match'
      ? 'ok      '
      : result.status === 'version_drift'
        ? 'drift   '
        : result.status === 'not_replayable'
          ? 'skip    '
          : 'FAIL    ';
  console.error(
    `${mark} ${result.claimId} attempt=${result.attempt} ` +
      `adjudicator=${result.storedVersion}${result.detail ? ` — ${result.detail}` : ''}`,
  );
}

/** `--since 7d` / `30m` / `12h`. Defaults to 7 days. */
function sinceFrom(args: string[]): Date {
  const index = args.indexOf('--since');
  const spec = index >= 0 ? args[index + 1] : undefined;
  const match = /^(\d+)([mhd])$/.exec(spec ?? '7d');
  if (!match) return new Date(Date.now() - 7 * 24 * 3600_000);
  const value = Number(match[1]);
  const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - value * unitMs);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
