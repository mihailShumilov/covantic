import { describe, expect, it } from 'vitest';
import { TriggerType } from '@covantic/shared';
import { verifyClaim } from '../src/services/claim-oracle.js';
import {
  AGENT,
  COVERAGE_RAW,
  NEGATIVES,
  POSITIVES,
  mkHelius,
  mkPricer,
  type CorpusCase,
} from './fixtures/corpus.js';

/**
 * The gate that turns "we think it works" into something a build can fail on.
 *
 * Asymmetric on purpose. A false positive means the vault pays for a trade
 * that was merely bad, and once that ships the protocol is quietly insuring
 * ordinary slippage — so any confirmation on the negatives fails the build,
 * with no allowance. Recall is a floor rather than a target, because the
 * honest response to an ambiguous case is review, not payment.
 */

/** Minimum share of manipulation shapes that must be confirmed outright. */
const RECALL_FLOOR = 0.8;

async function judge(testCase: CorpusCase) {
  return verifyClaim(
    TriggerType.OracleManipulation,
    testCase.tx.signature,
    AGENT,
    testCase.coverageRaw ?? COVERAGE_RAW,
    mkHelius(testCase.tx),
    mkPricer(testCase.feeds),
  );
}

describe('corpus B — hard negatives (zero false positives)', () => {
  for (const testCase of NEGATIVES) {
    it(`does not confirm: ${testCase.name}`, async () => {
      const result = await judge(testCase);
      // The failure message has to say why this case exists, or whoever hits
      // it in CI a year from now has no idea what they broke.
      expect(
        result.outcome,
        `${testCase.name} — ${testCase.why}\n` +
          `verifier said: ${result.outcome} (${String(result.details.reason)})`,
      ).not.toBe('confirmed');
      expect(result.lossAmount).toBe(0);
    });
  }

  it('confirms nothing across the whole negative corpus', async () => {
    const results = await Promise.all(NEGATIVES.map(judge));
    const falsePositives = NEGATIVES.filter((_, i) => results[i]!.outcome === 'confirmed');
    expect(falsePositives.map((c) => c.name)).toEqual([]);
  });

  it('never denies a claim it could not actually check', async () => {
    // Rejecting is a statement that the evidence contradicts the claim.
    // Outages, missing feeds and unsupported shapes are not that, and closing
    // a claim on one destroys a policyholder's cover for a problem on our
    // side of the wire.
    const unknowable = NEGATIVES.filter((c) =>
      ['price sources unavailable', 'unpriceable mint', 'many-to-many swap', 'single source',
       'two sources', 'references disagree', 'stale reference'].includes(c.name),
    );
    for (const testCase of unknowable) {
      const result = await judge(testCase);
      expect(result.outcome, `${testCase.name} must escalate, not deny`).toBe('indeterminate');
    }
  });
});

describe('corpus A/C — manipulation shapes', () => {
  for (const testCase of POSITIVES) {
    it(`sees the shape: ${testCase.name}`, async () => {
      const result = await judge(testCase);
      expect(
        result.outcome,
        `${testCase.name} — ${testCase.why}\n` +
          `verifier said: ${result.outcome} (${String(result.details.reason)})`,
      ).toBe('confirmed');
      expect(result.lossAmount).toBeGreaterThan(0);
    });
  }

  it('meets the recall floor', async () => {
    const results = await Promise.all(POSITIVES.map(judge));
    const confirmed = results.filter((r) => r.outcome === 'confirmed').length;
    const recall = confirmed / POSITIVES.length;
    expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });

  it('keeps every payout under the policy coverage', async () => {
    const results = await Promise.all(POSITIVES.map(judge));
    for (const [i, result] of results.entries()) {
      const coverage = POSITIVES[i]!.coverageRaw ?? COVERAGE_RAW;
      expect(result.lossAmount).toBeLessThanOrEqual(coverage);
    }
  });

  it('keeps every confirmation below the auto-pay confidence lane', async () => {
    // Until settlement verifies the price on chain, nothing decided off-chain
    // should be able to release funds without a human or a proof.
    const results = await Promise.all(POSITIVES.map(judge));
    for (const result of results) {
      expect(result.confidence).toBeLessThan(0.95);
    }
  });
});
