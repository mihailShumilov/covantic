import { describe, expect, it } from 'vitest';
import {
  AGENT_ERROR_ADJUDICATOR_VERSION,
  CONFIDENCE_CEILING,
  MIN_PAYABLE_LOSS_RAW,
  adjudicateAgentError,
} from '../src/services/agent-error/adjudicate.js';
import { AUTO_PAY_CONFIDENCE } from '../src/services/confidence-lanes.js';
import type { AgentErrorEvidenceBundle } from '../src/services/agent-error/types.js';
import type { AuthorizationReport } from '../src/services/exploit/authorization.js';
import type { LossAssessment } from '../src/services/exploit/loss.js';
import type { PositionDelta } from '../src/services/exploit/position.js';
import { AGENT, ATTACKER, OTHER_ATA, USDC } from './fixtures/exploit.js';
import { MATURE_MANDATE, IMMATURE_MANDATE } from './fixtures/agent-error-corpus.js';

/**
 * Unit tests for the pure agent-error adjudicator.
 *
 * These drive the verdict function directly rather than through the verifier,
 * which is what makes the ordering of its decisions testable: several of the
 * branches below are unreachable from a realistic transaction precisely
 * because an earlier one catches them, and that is the property worth pinning.
 */

const COVERAGE_RAW = 1_000_000 * 10 ** 6;

function position(partial: Partial<PositionDelta> = {}): PositionDelta {
  return {
    source: 'raw_tx',
    legs: [
      {
        mint: USDC,
        symbol: 'USDC',
        decimals: 6,
        beforeRaw: 10_000 * 10 ** 6,
        afterRaw: 0,
        deltaRaw: -10_000 * 10 ** 6,
        accounts: [],
      },
    ],
    controlledAccounts: [],
    unpriceableMints: [],
    ownershipChanges: [],
    feeLamports: 5_000,
    feePaidByAgent: true,
    hasAbsoluteBalances: true,
    ...partial,
  };
}

function authorization(partial: Partial<AuthorizationReport> = {}): AuthorizationReport {
  return {
    agentWasSigner: true,
    feePayer: AGENT,
    feePayerIsAgent: true,
    failed: false,
    movements: [],
    foreignAuthorities: [],
    foreignMovedRaw: {},
    controlChanges: [],
    approvalsGranted: [],
    destinations: [OTHER_ATA],
    selfDestinations: [],
    foreignDestinations: [OTHER_ATA],
    allDestinationsSelf: false,
    unevaluated: [],
    ...partial,
  };
}

function loss(netLossUsd = 10_000): LossAssessment {
  return {
    lost: [],
    gained: [],
    lostValueUsd: netLossUsd,
    gainedValueUsd: 0,
    netLossUsd,
    confUsd: 0,
    baseline: null,
    preIncidentValueUsd: null,
    drainRatio: null,
  };
}

function bundle(partial: Partial<AgentErrorEvidenceBundle> = {}): AgentErrorEvidenceBundle {
  return {
    version: '1.0.0',
    stage: 'verify',
    triggerType: 3,
    txSignature: 'SigTest',
    agentAddress: AGENT,
    coverageRaw: COVERAGE_RAW,
    coveredMint: USDC,
    slot: 1,
    blockTime: 1_700_000_000,
    hasRawTx: true,
    mandate: MATURE_MANDATE,
    position: position(),
    loss: loss(),
    authorization: authorization(),
    breach: {
      breached: true,
      dimensions: [
        {
          dimension: 'single_outflow',
          kind: 'quantitative',
          declared: MATURE_MANDATE.maxSingleOutflowRaw,
          observed: 10_000 * 10 ** 6,
          excessRaw: 9_000 * 10 ** 6,
          chainCheckable: true,
        },
      ],
      excessRaw: 9_000 * 10 ** 6,
      provable: true,
      unevaluated: [],
    },
    prices: [],
    windows: {},
    collectedAt: 0,
    ...partial,
  };
}

describe('adjudicateAgentError — gaps in the record are never rejections', () => {
  it('escalates when the mandate lookup never ran', () => {
    const verdict = adjudicateAgentError(bundle({ mandate: undefined }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('mandate_lookup_unavailable');
  });

  it('escalates when no mandate has been declared', () => {
    const verdict = adjudicateAgentError(bundle({ mandate: null }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('no_mandate_declared');
    expect(verdict.retryAfterSec).toBeGreaterThan(0);
  });

  it('escalates when the mandate had not matured before the claim', () => {
    const verdict = adjudicateAgentError(bundle({ mandate: IMMATURE_MANDATE }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('mandate_not_matured');
  });

  it('escalates when only the indexer payload was available', () => {
    const verdict = adjudicateAgentError(bundle({ hasRawTx: false }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('no_chain_record');
  });

  it('escalates when the position could not be priced', () => {
    const verdict = adjudicateAgentError(bundle({ loss: undefined }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('position_not_valued');
  });
});

describe('adjudicateAgentError — the complement of the exploit verdict', () => {
  it('rejects a movement the agent did not authorise, and names where it belongs', () => {
    const verdict = adjudicateAgentError(
      bundle({
        authorization: authorization({
          agentWasSigner: false,
          foreignAuthorities: [ATTACKER],
        }),
      }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('not_agent_authorized');
    expect(verdict.details.belongsTo).toBe('exploit');
  });

  it('routes a seizure to the governance trigger rather than to this one', () => {
    const verdict = adjudicateAgentError(
      bundle({
        authorization: authorization({
          agentWasSigner: false,
          foreignAuthorities: [ATTACKER],
          controlChanges: [
            {
              type: 'setAuthority',
              account: OTHER_ATA,
              authority: ATTACKER,
              authorityIsAgent: false,
              viaCpi: false,
            },
          ],
        }),
      }),
    );

    expect(verdict.details.belongsTo).toBe('governance_attack');
  });

  it('checks authorisation before the transaction-failed branch', () => {
    // Ordering matters: a reverted transaction signed by a stranger is still
    // not an agent error, and the reason a reviewer reads should say so.
    const verdict = adjudicateAgentError(
      bundle({
        authorization: authorization({
          agentWasSigner: false,
          foreignAuthorities: [ATTACKER],
          failed: true,
        }),
      }),
    );

    expect(verdict.reason).toBe('not_agent_authorized');
  });
});

describe('adjudicateAgentError — what is not a covered event', () => {
  it('rejects a reverted transaction instead of inventing a fee-shaped loss', () => {
    // The retired verifier approved a flat 1 USDC here, above its own dust
    // floor, so every reverted transaction confirmed.
    const verdict = adjudicateAgentError(
      bundle({ authorization: authorization({ failed: true }) }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('transaction_reverted_no_loss');
    expect(verdict.lossAmount).toBe(0);
  });

  it('rejects a movement that landed back with the family', () => {
    const verdict = adjudicateAgentError(
      bundle({ authorization: authorization({ allDestinationsSelf: true }) }),
    );

    expect(verdict.reason).toBe('self_transfer');
  });

  it('rejects when value received matched value given up', () => {
    const verdict = adjudicateAgentError(bundle({ loss: loss(0) }));

    expect(verdict.reason).toBe('no_net_loss');
  });

  it('rejects a movement inside the declared envelope, whatever it was routed through', () => {
    const verdict = adjudicateAgentError(
      bundle({
        breach: { breached: false, dimensions: [], excessRaw: 0, provable: false, unevaluated: [] },
      }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('within_mandate');
  });

  it('rejects an overshoot too small to be worth a claim', () => {
    const verdict = adjudicateAgentError(
      bundle({
        breach: {
          breached: true,
          dimensions: [],
          excessRaw: MIN_PAYABLE_LOSS_RAW - 1,
          provable: true,
          unevaluated: [],
        },
      }),
    );

    expect(verdict.reason).toBe('breach_below_dust');
  });
});

describe('adjudicateAgentError — the abuse the declaration cannot close alone', () => {
  const history = (medianOutflowRaw: number, stale = false) => ({
    windowSeconds: 3_600,
    transferCount: 40,
    meanOutflowRaw: medianOutflowRaw,
    medianOutflowRaw,
    p95OutflowRaw: medianOutflowRaw * 2,
    windowOutflowRaw: 0,
    observedFrom: 0,
    computedAt: 0,
    stale,
  });

  it('escalates a cap below what the agent has actually been paying', () => {
    // The narrow-envelope attack: declare a cap far under ordinary operation,
    // send value to a third wallet you also control, and claim the overshoot.
    // `self_transfer` does not catch it — it knows only about the holder and
    // the agent — and the maturity delay does not either, because the
    // declaration is genuinely made in advance.
    const verdict = adjudicateAgentError(
      bundle({
        mandate: { ...MATURE_MANDATE, maxSingleOutflowRaw: 1 },
        outflowBaseline: history(500 * 10 ** 6),
      }),
    );

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('mandate_contradicts_history');
  });

  it('escalates rather than rejecting, because tightening a cap is legitimate too', () => {
    // A holder restraining a misbehaving agent produces exactly the same
    // shape, and nothing available here separates the two. Closing the claim
    // would punish the honest reading.
    const verdict = adjudicateAgentError(
      bundle({
        mandate: { ...MATURE_MANDATE, maxSingleOutflowRaw: 1 },
        outflowBaseline: history(500 * 10 ** 6),
      }),
    );

    expect(verdict.outcome).not.toBe('rejected');
    expect(verdict.retryAfterSec).toBeGreaterThan(0);
  });

  it('leaves an ordinary cap alone', () => {
    const verdict = adjudicateAgentError(
      bundle({ outflowBaseline: history(100 * 10 ** 6) }),
    );

    expect(verdict.outcome).toBe('confirmed');
  });

  it('does not escalate on a history too thin to mean anything', () => {
    // A stale or sparse baseline is not evidence of anything, so it must not
    // be turned into an accusation.
    const verdict = adjudicateAgentError(
      bundle({
        mandate: { ...MATURE_MANDATE, maxSingleOutflowRaw: 1 },
        outflowBaseline: history(500 * 10 ** 6, true),
      }),
    );

    expect(verdict.outcome).toBe('confirmed');
  });
});

describe('adjudicateAgentError — what it pays', () => {
  it('pays the overshoot beyond the declared cap, not the whole loss', () => {
    const verdict = adjudicateAgentError(bundle());

    expect(verdict.outcome).toBe('confirmed');
    expect(verdict.lossAmount).toBe(9_000 * 10 ** 6);
    expect(verdict.details.boundedBy).toBe('declared_overshoot');
  });

  it('never pays more than the loss, even when the overshoot is larger', () => {
    // A declared cap far below a small loss must not manufacture a payout.
    const verdict = adjudicateAgentError(
      bundle({
        loss: loss(100),
        breach: {
          breached: true,
          dimensions: [],
          excessRaw: 9_000 * 10 ** 6,
          provable: true,
          unevaluated: [],
        },
      }),
    );

    expect(verdict.lossAmount).toBe(100 * 10 ** 6);
  });

  it('caps at the policy coverage', () => {
    const verdict = adjudicateAgentError(
      bundle({
        coverageRaw: 500 * 10 ** 6,
        loss: loss(10_000),
      }),
    );

    expect(verdict.lossAmount).toBe(500 * 10 ** 6);
  });

  it('falls back to the loss when the breach is one the chain cannot re-derive', () => {
    const verdict = adjudicateAgentError(
      bundle({
        breach: {
          breached: true,
          dimensions: [
            {
              dimension: 'counterparty',
              kind: 'categorical',
              declared: [],
              observed: [ATTACKER],
              excessRaw: 0,
              chainCheckable: false,
            },
          ],
          excessRaw: 0,
          provable: false,
          unevaluated: [],
        },
      }),
    );

    expect(verdict.outcome).toBe('confirmed');
    expect(verdict.details.boundedBy).toBe('net_loss');
    expect(verdict.details.breachProvable).toBe(false);
  });
});

describe('adjudicateAgentError — structural properties', () => {
  it('caps confidence below the auto-pay bar', () => {
    // The gap is the guarantee: off-chain analysis can never release funds on
    // its own, however well corroborated.
    const verdict = adjudicateAgentError(bundle());

    expect(verdict.confidence).toBeLessThanOrEqual(CONFIDENCE_CEILING);
    expect(CONFIDENCE_CEILING).toBeLessThan(AUTO_PAY_CONFIDENCE);
  });

  it('scores a chain-checkable breach above one that is only asserted', () => {
    const provable = adjudicateAgentError(bundle());
    const categorical = adjudicateAgentError(
      bundle({
        breach: {
          breached: true,
          dimensions: [
            {
              dimension: 'counterparty',
              kind: 'categorical',
              declared: [],
              observed: [ATTACKER],
              excessRaw: 0,
              chainCheckable: false,
            },
          ],
          excessRaw: 0,
          provable: false,
          unevaluated: [],
        },
      }),
    );

    expect(provable.confidence).toBeGreaterThan(categorical.confidence);
  });

  it('costs confidence for every check that could not run', () => {
    const clean = adjudicateAgentError(bundle());
    const holes = adjudicateAgentError(
      bundle({
        breach: {
          ...bundle().breach!,
          unevaluated: [
            { check: 'counterparty', reason: 'undeclared' },
            { check: 'program', reason: 'undeclared' },
            { check: 'window_outflow', reason: 'no history' },
          ],
        },
      }),
    );

    expect(holes.confidence).toBeLessThan(clean.confidence);
  });

  it('is a pure function of the bundle', () => {
    // No I/O, no clock, no randomness — the contract `pnpm claim:replay` and
    // the on-chain evidence hash both rest on.
    const evidence = bundle();

    expect(adjudicateAgentError(evidence)).toEqual(adjudicateAgentError(evidence));
    expect(AGENT_ERROR_ADJUDICATOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
