import { describe, expect, it } from 'vitest';
import { TriggerType } from '@covantic/shared';
import { verifyClaim } from '../src/services/claim-oracle.js';
import { AUTO_PAY_CONFIDENCE, decideLane } from '../src/services/confidence-lanes.js';
import { bundleHash, verdictHash } from '../src/services/oracle/hash.js';
import { adjudicateGovernance } from '../src/services/governance/adjudicate.js';
import type { GovernanceEvidenceBundle } from '../src/services/governance/types.js';
import { AGENT, HOLDER } from './fixtures/exploit.js';
import { mkPricer } from './fixtures/corpus.js';
import {
  COVERAGE_RAW,
  NEGATIVES,
  POSITIVES,
  baselineFor,
  mkReader,
  mkHelius,
  mkHolders,
  type GovernanceCase,
} from './fixtures/governance-corpus.js';
import { mkEnhanced } from './fixtures/exploit-corpus.js';

/**
 * The gate that turns "we think it works" into something a build can fail on.
 *
 * Asymmetric on purpose. A false positive means the vault paid because a
 * holder rotated a key, and once that ships the protocol is quietly insuring
 * routine operations — so any confirmation on the negatives fails the build,
 * with no allowance. Recall is a floor rather than a target, because the
 * honest response to an ambiguous case is review.
 */

/** Minimum share of takeover shapes that must be confirmed outright. */
const RECALL_FLOOR = 0.8;

const FEEDS = { 'USDC/USD': { price: 1 }, 'SOL/USD': { price: 200 } };

async function judge(testCase: GovernanceCase) {
  const signature = `Sig_${testCase.name.replace(/\W+/g, '_')}`;
  const enhanced = mkEnhanced(testCase.tx, signature);
  const holders = mkHolders(testCase);
  return verifyClaim(
    TriggerType.GovernanceAttack,
    signature,
    AGENT,
    COVERAGE_RAW,
    mkHelius(enhanced),
    mkPricer(FEEDS),
    {
      reader: mkReader(testCase.tx, signature),
      holderAddress: HOLDER,
      governance: {
        baseline: async () => baselineFor(testCase),
        holdingsBefore: holders.holdingsBefore,
        holdingsNow: holders.holdingsNow,
      },
    },
  );
}

describe('governance corpus — negatives (hard gate)', () => {
  for (const testCase of NEGATIVES) {
    it(`never confirms: ${testCase.name}`, async () => {
      const result = await judge(testCase);

      expect(result.outcome, testCase.why).not.toBe('confirmed');
      expect(result.lossAmount).toBe(0);
    });
  }
});

describe('governance corpus — positives', () => {
  for (const testCase of POSITIVES) {
    it(`resolves: ${testCase.name}`, async () => {
      const result = await judge(testCase);

      // A positive may confirm or escalate; it may never be *closed*, because
      // closing says the evidence contradicts the claim.
      expect(result.outcome, testCase.why).not.toBe('rejected');
    });
  }

  it('confirms enough of the takeover shapes to be worth selling', async () => {
    const results = await Promise.all(POSITIVES.map(judge));
    const confirmed = results.filter((r) => r.outcome === 'confirmed');
    const recall = confirmed.length / POSITIVES.length;

    // Logged rather than merely asserted: a silently drifting recall number
    // is how a detector stops working without anyone noticing.
    // eslint-disable-next-line no-console
    console.warn(
      `governance corpus recall: ${confirmed.length}/${POSITIVES.length} ` +
        `(${(recall * 100).toFixed(0)}%), floor ${(RECALL_FLOOR * 100).toFixed(0)}%`,
    );
    expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });
});

describe('governance corpus — the lane the verdicts land in', () => {
  it('never releases funds without the chain corroborating', async () => {
    // The structural guarantee, exercised end to end rather than asserted on
    // a constant: every confirmation must still route through a proof path.
    const results = await Promise.all(POSITIVES.map(judge));
    for (const result of results.filter((r) => r.outcome === 'confirmed')) {
      expect(result.confidence).toBeLessThan(AUTO_PAY_CONFIDENCE);

      const lane = decideLane({
        triggerType: TriggerType.GovernanceAttack,
        confidence: result.confidence,
        proofAvailable: true,
      });
      expect(lane.lane === 'review' || lane.requiresChainProof === true).toBe(true);
    }
  });

  it('sends a confirmed claim to review when no proof path is available', async () => {
    // What every governance claim does today, before the program is
    // redeployed and the flag is turned on.
    const results = await Promise.all(POSITIVES.map(judge));
    for (const result of results.filter((r) => r.outcome === 'confirmed')) {
      const lane = decideLane({
        triggerType: TriggerType.GovernanceAttack,
        confidence: result.confidence,
        proofAvailable: false,
      });
      expect(lane.lane).toBe('review');
    }
  });
});

describe('governance corpus — every verdict is replayable', () => {
  it('re-derives an identical verdict from the stored bundle', async () => {
    for (const testCase of [...POSITIVES, ...NEGATIVES]) {
      const result = await judge(testCase);
      const bundle = result.evidence as GovernanceEvidenceBundle | undefined;
      expect(bundle, `${testCase.name} produced no evidence bundle`).toBeDefined();
      if (!bundle) continue;

      const hash = bundleHash(bundle as unknown as Record<string, unknown>);
      const first = adjudicateGovernance(bundle);
      const second = adjudicateGovernance(bundle);
      expect(verdictHash(hash, first)).toBe(verdictHash(hash, second));
    }
  });
});
