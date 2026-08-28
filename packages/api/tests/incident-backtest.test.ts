import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TriggerType } from '@covantic/shared';
import { verifyClaim, type VerificationResult } from '../src/services/claim-oracle.js';
import { AUTO_PAY_CONFIDENCE, decideLane } from '../src/services/confidence-lanes.js';
import { bundleHash, verdictHash } from '../src/services/oracle/hash.js';
import {
  cassetteConnection,
  cassetteHelius,
  cassettePricer,
} from '../src/services/backtest/replay.js';
import type { Cassette } from '../src/services/backtest/types.js';
import { INCIDENT_CASES } from './fixtures/incidents/manifest.js';

/**
 * The backtest: the pipeline run against Solana mainnet as it actually
 * happened.
 *
 * The hand-built corpora next door pin the specific mistakes the previous
 * verifiers made. They cannot do more than that, because every byte in them
 * was written by the same people who wrote the detector, so they only ever
 * ask about transactions someone thought of. This file asks a different
 * question: given several hundred real transactions that nobody chose for
 * their properties, and the largest theft in the chain's history, does the
 * pipeline stay quiet where it should?
 *
 * The gate is one-sided, for the reason it is one-sided everywhere else. A
 * false positive is the vault paying for something that was not a covered
 * loss, and there is no version of that which is recoverable. So a single
 * confirmation anywhere in the negative set fails the build.
 *
 * The corpus is committed, not fetched: `pnpm backtest:fetch` rebuilds it
 * from the public archival endpoint, and CI replays what is on disk with no
 * network at all.
 */

const HERE = fileURLToPath(new URL('./fixtures/incidents/', import.meta.url));

/**
 * A policy holder who appears nowhere in any of these transactions.
 *
 * This is the least favourable configuration available, and that is
 * deliberate. Value landing somewhere the holder controls is not a loss, so
 * naming a holder who is present in the transaction would let the pipeline
 * dismiss cases for a reason the backtest handed it. With a stranger as the
 * holder, every destination is foreign and every case has to be dismissed on
 * its own evidence.
 */
const ABSENT_HOLDER = 'CovanticBacktestHo1derAbsentFromEveryTx1111';

/** No mandate and no governance baseline are supplied either — the state a
 *  policy is in before its holder declares anything. */
const NO_DECLARATIONS = {};

const ALL_TRIGGERS = [
  TriggerType.Exploit,
  TriggerType.OracleManipulation,
  TriggerType.GovernanceAttack,
  TriggerType.AgentError,
];

const COVERAGE_RAW = 1_000_000 * 10 ** 6;

function loadNdjson(file: string): Cassette[] {
  const path = `${HERE}${file}`;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Cassette);
}

function loadCassette(name: string): Cassette {
  return JSON.parse(readFileSync(`${HERE}cassettes/${name}`, 'utf8')) as Cassette;
}

async function judge(
  cassette: Cassette,
  subject: string,
  trigger: number,
  coverageRaw = COVERAGE_RAW,
): Promise<VerificationResult> {
  return verifyClaim(
    trigger,
    cassette.signature,
    subject,
    coverageRaw,
    cassetteHelius(cassette),
    cassettePricer(cassette),
    {
      connection: cassetteConnection(cassette),
      holderAddress: ABSENT_HOLDER,
      ...NO_DECLARATIONS,
    },
  );
}

const NEGATIVES = loadNdjson('negatives.ndjson');
const UNAUTHORISED = loadNdjson('unauthorised.ndjson');

// ---------------------------------------------------------------------------
// Ordinary mainnet traffic
// ---------------------------------------------------------------------------

describe('backtest — ordinary mainnet transactions (hard gate)', () => {
  it('has a corpus to run against', () => {
    // A silently empty corpus is a green build that tested nothing, which is
    // the failure mode this whole file exists to avoid elsewhere.
    expect(
      NEGATIVES.length,
      'negatives.ndjson is missing or empty — run `pnpm backtest:fetch`',
    ).toBeGreaterThanOrEqual(100);
  });

  it('confirms nothing, across every trigger', async () => {
    const confirmations: string[] = [];

    for (const cassette of NEGATIVES) {
      const subject = cassette.subject;
      if (!subject) continue;
      for (const trigger of ALL_TRIGGERS) {
        const result = await judge(cassette, subject, trigger);
        if (result.outcome === 'confirmed') {
          confirmations.push(
            `${cassette.signature} trigger=${trigger} loss=${result.lossAmount} ` +
              `reason=${String(result.details.reason)}`,
          );
        }
      }
    }

    expect(confirmations).toEqual([]);
  }, 120_000);

  it('moves no money at all', async () => {
    // The same guarantee stated in the only unit that matters.
    let total = 0;
    for (const cassette of NEGATIVES) {
      if (!cassette.subject) continue;
      for (const trigger of ALL_TRIGGERS) {
        total += (await judge(cassette, cassette.subject, trigger)).lossAmount;
      }
    }
    expect(total).toBe(0);
  }, 120_000);

  it('terminates every case in one of the three states', async () => {
    for (const cassette of NEGATIVES.slice(0, 40)) {
      if (!cassette.subject) continue;
      for (const trigger of ALL_TRIGGERS) {
        const result = await judge(cassette, cassette.subject, trigger);
        expect(['confirmed', 'rejected', 'indeterminate']).toContain(result.outcome);
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Documented incidents
// ---------------------------------------------------------------------------

describe('backtest — documented incidents', () => {
  for (const testCase of INCIDENT_CASES) {
    it(`${testCase.expect}: ${testCase.cassette}`, async () => {
      const cassette = loadCassette(testCase.cassette);
      for (const trigger of testCase.triggers) {
        const result = await judge(cassette, testCase.subject, trigger, testCase.coverageRaw);

        if (testCase.expect === 'never-confirms') {
          expect(
            result.outcome,
            `${testCase.cassette} trigger=${trigger} — ${testCase.why}\n` +
              `verifier said: ${result.outcome} (${String(result.details.reason)})`,
          ).not.toBe('confirmed');
          expect(result.lossAmount).toBe(0);
        }

        if (testCase.expect === 'detects') {
          expect(result.outcome, testCase.why).not.toBe('rejected');
        }
      }
    }, 30_000);
  }

  it('re-derives every incident verdict byte-identically', async () => {
    // The determinism guarantee, checked on evidence assembled from real
    // chain data rather than from a fixture built to be well-behaved.
    for (const testCase of INCIDENT_CASES) {
      const cassette = loadCassette(testCase.cassette);
      const first = await judge(cassette, testCase.subject, TriggerType.Exploit);
      const second = await judge(cassette, testCase.subject, TriggerType.Exploit);
      expect(first.evidence, testCase.cassette).toBeDefined();

      const hashOf = (r: VerificationResult) =>
        verdictHash(bundleHash(r.evidence as unknown as Record<string, unknown>), {
          outcome: r.outcome,
          lossAmount: r.lossAmount,
          confidence: r.confidence,
        });
      expect(hashOf(second), testCase.cassette).toBe(hashOf(first));
    }
  }, 60_000);

  it('never reaches the auto-pay lane on off-chain evidence', async () => {
    for (const testCase of INCIDENT_CASES) {
      const cassette = loadCassette(testCase.cassette);
      for (const trigger of testCase.triggers) {
        const result = await judge(cassette, testCase.subject, trigger, testCase.coverageRaw);
        expect(result.confidence).toBeLessThan(AUTO_PAY_CONFIDENCE);
        if (result.outcome === 'confirmed') {
          expect(
            decideLane({
              triggerType: trigger,
              confidence: result.confidence,
              proofAvailable: false,
            }).lane,
          ).toBe('review');
        }
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Unauthorised outflows
// ---------------------------------------------------------------------------

/**
 * Real transactions where value left a token account whose owner neither
 * signed nor held the moving authority.
 *
 * This is a recall *probe*, not a recall measurement, and the difference
 * matters enough to state. The selection rule overlaps the authorization test
 * the exploit verifier applies, so a high confirmation rate here is partly
 * the corpus agreeing with itself. What it can say honestly is the negative:
 * a `rejected` verdict is the pipeline asserting that value did not leave
 * without the owner's authority, on a transaction where the chain record says
 * it did — and that is a defect whichever way the case was selected.
 */
describe('backtest — unauthorised outflows', () => {
  it('never denies one', async () => {
    if (UNAUTHORISED.length === 0) return;
    const denied: string[] = [];

    for (const cassette of UNAUTHORISED) {
      if (!cassette.subject) continue;
      const result = await judge(cassette, cassette.subject, TriggerType.Exploit);
      if (result.outcome === 'rejected') {
        denied.push(`${cassette.signature}: ${String(result.details.reason)}`);
      }
    }

    expect(denied).toEqual([]);
  }, 120_000);
});
