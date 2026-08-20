import { describe, expect, it } from 'vitest';
import { TriggerType } from '@covantic/shared';
import { verifyClaim } from '../src/services/claim-oracle.js';
import { AUTO_PAY_CONFIDENCE, decideLane } from '../src/services/confidence-lanes.js';
import { CONFIDENCE_CEILING, adjudicateAgentError } from '../src/services/agent-error/adjudicate.js';
import type { AgentErrorEvidenceBundle } from '../src/services/agent-error/types.js';
import { bundleHash, verdictHash } from '../src/services/oracle/hash.js';
import { planProvenSettlement } from '../src/services/settlement-plan.js';
import { AGENT, HOLDER, USDC } from './fixtures/exploit.js';
import { mkPricer } from './fixtures/corpus.js';
import { mkConnection, mkEnhanced, mkHelius } from './fixtures/exploit-corpus.js';
import {
  ALL_CASES,
  COVERAGE_RAW,
  MATURE_MANDATE,
  NEGATIVES,
  POSITIVES,
  type AgentErrorCase,
} from './fixtures/agent-error-corpus.js';

/**
 * The gate that turns "we think it works" into something a build can fail on.
 *
 * Asymmetric on purpose, and the asymmetry matters more on this trigger than
 * anywhere else. A false positive here means the vault paid because an agent
 * spent its own money the way its owner told it to — and the verifier this
 * replaced did exactly that for bridge transfers, for deposits into
 * unrecognised programs, and for every reverted transaction. So a confirmation
 * on any negative fails the build with no allowance.
 */

/** Minimum share of breach shapes that must be confirmed outright. */
const RECALL_FLOOR = 0.8;

const FEEDS = { 'USDC/USD': { price: 1 }, 'SOL/USD': { price: 200 } };

async function judge(testCase: AgentErrorCase) {
  const signature = `Sig_${testCase.name.replace(/\W+/g, '_')}`;
  const enhanced = mkEnhanced(testCase.tx, signature);
  // `undefined` in the fixture means the lookup could not run at all; that is
  // modelled by a reader that throws, not by one that returns nothing.
  const mandate =
    'mandate' in testCase && testCase.mandate === undefined
      ? () => Promise.reject(new Error('rpc unavailable'))
      : () => Promise.resolve('mandate' in testCase ? testCase.mandate! : MATURE_MANDATE);

  return verifyClaim(
    TriggerType.AgentError,
    signature,
    AGENT,
    COVERAGE_RAW,
    mkHelius(enhanced),
    mkPricer(FEEDS),
    {
      connection: mkConnection(testCase.tx, signature),
      holderAddress: HOLDER,
      usdcMint: USDC,
      agentError: { mandate, outflowBaseline: () => Promise.resolve(null) },
    },
  );
}

describe('agent-error corpus — negatives (hard gate)', () => {
  for (const testCase of NEGATIVES) {
    it(`never confirms: ${testCase.name}`, async () => {
      const result = await judge(testCase);

      expect(result.outcome, testCase.why).not.toBe('confirmed');
      expect(result.lossAmount).toBe(0);
      if (testCase.expectReason) {
        expect(result.details.reason, testCase.why).toBe(testCase.expectReason);
      }
    });
  }

  it('confirms none of them, as a set', async () => {
    const results = await Promise.all(NEGATIVES.map(judge));
    const confirmed = NEGATIVES.filter((_, i) => results[i]!.outcome === 'confirmed');

    expect(confirmed.map((c) => c.name)).toEqual([]);
  });

  it('pays out nothing at all across the negative set', async () => {
    const results = await Promise.all(NEGATIVES.map(judge));

    expect(results.reduce((sum, r) => sum + r.lossAmount, 0)).toBe(0);
  });

  it('never *rejects* a claim merely because a declaration was missing', async () => {
    // The direction that matters. A policy with no mandate, or one whose
    // mandate could not be read, has a gap in our records — not a holder who
    // consented. Closing those claims would destroy valid ones silently.
    const gaps = NEGATIVES.filter((c) =>
      ['no_mandate_declared', 'mandate_not_matured', 'mandate_lookup_unavailable'].includes(
        c.expectReason ?? '',
      ),
    );
    expect(gaps.length).toBeGreaterThan(0);

    for (const testCase of gaps) {
      const result = await judge(testCase);
      expect(result.outcome, testCase.name).toBe('indeterminate');
      expect(result.retryAfterSec).toBeGreaterThan(0);
    }
  });
});

describe('agent-error corpus — positives (tracked recall)', () => {
  for (const testCase of POSITIVES) {
    it(`detects: ${testCase.name}`, async () => {
      const result = await judge(testCase);

      expect(result.outcome, testCase.why).toBe('confirmed');
      expect(result.lossAmount).toBeGreaterThan(0);
      if (testCase.expectReason) {
        expect(result.details.reason).toBe(testCase.expectReason);
      }
      if (testCase.expectLossAmount !== undefined) {
        expect(result.lossAmount).toBe(testCase.expectLossAmount);
      }
    });
  }

  it('meets the recall floor', async () => {
    const results = await Promise.all(POSITIVES.map(judge));
    const confirmed = results.filter((r) => r.outcome === 'confirmed').length;

    expect(confirmed / POSITIVES.length).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });

  it('pays the overshoot, not the loss', async () => {
    // The design decision worth a test of its own. The holder declared how
    // much their agent was permitted to move, so the first slice of any breach
    // is risk they said they were willing to run — a deductible they authored
    // themselves.
    const fatFinger = POSITIVES.find((c) => c.name.startsWith('fat-finger'))!;
    const result = await judge(fatFinger);

    expect(result.lossAmount).toBe(fatFinger.expectLossAmount);
    expect(result.lossAmount).toBeLessThan(10_000 * 10 ** 6);
    expect(result.details.boundedBy).toBe('declared_overshoot');
  });
});

describe('agent-error corpus — structural guarantees', () => {
  it('refuses the proven path for a breach the chain cannot re-derive', async () => {
    // The distinction the other three triggers do not have to make. A mandate
    // has five dimensions and the program can re-check two: it reads the
    // covered account's balance, so it sees the outflow cap and the retention
    // floor. It cannot inspect a past transaction, so it can see neither the
    // destination nor the route.
    //
    // A breach of only those dimensions is real and confirms — but sending it
    // to `verify_and_payout_agent_error` would produce a transaction that
    // reverts, and the keeper marks a failed payout `failed` rather than
    // `review`, turning a valid claim into a dead one. So it must fail closed
    // in the planner instead.
    const categorical = POSITIVES.filter((c) => c.categoricalOnly);
    expect(categorical.length).toBeGreaterThan(0);

    for (const testCase of categorical) {
      const result = await judge(testCase);
      expect(result.outcome, testCase.name).toBe('confirmed');
      expect(result.details.breachProvable).toBe(false);
      expect(result.details.boundedBy).toBe('net_loss');

      const plan = planProvenSettlement(
        {
          triggerType: TriggerType.AgentError,
          verificationData: { ...result.details, bundleHash: 'ab'.repeat(32) },
        } as never,
        { AGENT_ERROR_PROOF_ENABLED: true } as never,
      );
      expect(plan).toEqual({ kind: 'unprovable', reason: 'breach_not_chain_checkable' });
    }
  });

  it('takes the proven path when the chain can re-derive the overshoot', async () => {
    const quantitative = POSITIVES.filter((c) => !c.categoricalOnly);

    for (const testCase of quantitative) {
      const result = await judge(testCase);
      expect(result.details.breachProvable, testCase.name).toBe(true);

      const plan = planProvenSettlement(
        {
          triggerType: TriggerType.AgentError,
          verificationData: { ...result.details, bundleHash: 'ab'.repeat(32) },
        } as never,
        { AGENT_ERROR_PROOF_ENABLED: true } as never,
      );
      expect(plan).toMatchObject({ kind: 'proven_mandate' });
    }
  });

  it('never reaches the auto-pay lane on off-chain evidence alone', async () => {
    // The ceiling is what makes "the chain always checks" structural rather
    // than a policy someone can relax: no bundle, however corroborated, can
    // score high enough to release funds without the program's own arithmetic.
    const results = await Promise.all(POSITIVES.map(judge));

    for (const result of results) {
      if (result.outcome !== 'confirmed') continue;
      expect(result.confidence).toBeLessThanOrEqual(CONFIDENCE_CEILING);
      expect(result.confidence).toBeLessThan(AUTO_PAY_CONFIDENCE);
      expect(
        decideLane({
          triggerType: TriggerType.AgentError,
          confidence: result.confidence,
          proofAvailable: false,
        }).lane,
      ).toBe('review');
    }
  });

  it('attaches a replayable evidence bundle to every verdict', async () => {
    // This trigger produced no bundle at all before the change, so
    // `recordEvidence` returned early on every claim and an agent-error payout
    // was not reproducible even in principle.
    for (const testCase of ALL_CASES) {
      const result = await judge(testCase);
      expect(result.evidence, testCase.name).toBeDefined();
      expect(result.evidence).toMatchObject({ triggerType: TriggerType.AgentError });
    }
  });

  it('re-derives an identical verdict from the stored bundle', async () => {
    for (const testCase of ALL_CASES) {
      const result = await judge(testCase);
      const bundle = result.evidence as AgentErrorEvidenceBundle;

      const first = adjudicateAgentError(bundle);
      const second = adjudicateAgentError(bundle);

      expect(second, testCase.name).toEqual(first);
      expect(first.outcome).toBe(result.outcome);
      expect(first.lossAmount).toBe(result.lossAmount);
    }
  });

  it('hashes a bundle stably, and excludes the capture time', async () => {
    const result = await judge(POSITIVES[0]!);
    const bundle = result.evidence as unknown as Record<string, unknown>;

    const hash = bundleHash(bundle);
    expect(bundleHash({ ...bundle })).toBe(hash);
    // `collectedAt` is provenance, not evidence. Including it would make every
    // replay hash differently and the on-chain commitment meaningless.
    expect(bundleHash({ ...bundle, collectedAt: 1 })).toBe(hash);

    const verdict = { outcome: result.outcome, lossAmount: result.lossAmount };
    expect(verdictHash(hash, verdict)).toBe(verdictHash(hash, verdict));
  });
});
