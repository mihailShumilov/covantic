import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_CEILING,
  GOVERNANCE_ADJUDICATOR_VERSION,
  MIN_PAYABLE_LOSS_RAW,
  adjudicateGovernance,
} from '../src/services/governance/adjudicate.js';
import { AUTO_PAY_CONFIDENCE } from '../src/services/confidence-lanes.js';
import { bundleHash, verdictHash } from '../src/services/oracle/hash.js';
import type { AuthorityReport, Takeover } from '../src/services/governance/authority.js';
import type { GovernanceExposure } from '../src/services/governance/conjunction.js';
import type { GovernanceSignatureReport } from '../src/services/governance/signatures.js';
import {
  GOVERNANCE_BUNDLE_VERSION,
  type GovernanceBaselineView,
  type GovernanceEvidenceBundle,
} from '../src/services/governance/types.js';
import { AGENT, ATTACKER, AGENT_USDC_ATA, HOLDER, USDC } from './fixtures/governance.js';

const COVERAGE_RAW = 1_000_000 * 10 ** 6;
const OPERATOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function takeover(over: Partial<Takeover> = {}): Takeover {
  return {
    kind: 'owner',
    account: AGENT_USDC_ATA,
    mint: USDC,
    amountRaw: 50_000e6,
    previousAuthority: AGENT,
    newAuthority: ATTACKER,
    signer: ATTACKER,
    signerIsAgent: false,
    signerIsHolder: false,
    newAuthorityIsSelf: false,
    viaCpi: false,
    invokedBy: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ...over,
  };
}

function authority(over: Partial<AuthorityReport> = {}): AuthorityReport {
  const takeovers = over.takeovers ?? [takeover()];
  return {
    agentWasSigner: false,
    holderWasSigner: false,
    feePayer: ATTACKER,
    failed: false,
    takeovers,
    foreignTakeovers: takeovers.filter((t) => !t.newAuthorityIsSelf),
    ownerChanges: [],
    agentAccounts: [AGENT_USDC_ATA],
    unevaluated: [],
    ...over,
  };
}

function exposure(over: Partial<GovernanceExposure> = {}): GovernanceExposure {
  return {
    shape: 'drain',
    gone: [],
    frozen: [],
    goneValueUsd: 50_000,
    frozenValueUsd: 0,
    exposureUsd: 50_000,
    confUsd: 10,
    preIncidentValueUsd: 60_000,
    exposureRatio: 0.83,
    measuredFromBlockTime: 1_700_000_000 - 300,
    measuredToBlockTime: 1_700_000_000 + 300,
    takeoverBlockTime: 1_700_000_000,
    windowSec: 1_800,
    withinWindow: true,
    unevaluated: [],
    ...over,
  };
}

function signatures(over: Partial<GovernanceSignatureReport> = {}): GovernanceSignatureReport {
  return {
    findings: [],
    present: ['authority_left_manifest', 'takeover_signer_foreign'],
    unevaluated: [],
    score: 0.85,
    hasAuthorizationEvidence: true,
    ...over,
  };
}

function baseline(over: Partial<GovernanceBaselineView> = {}): GovernanceBaselineView {
  return {
    authorities: [AGENT, HOLDER, OPERATOR],
    tokenOwner: AGENT,
    expectedDelegate: null,
    expectedCloseAuthority: null,
    programUpgradeAuthority: null,
    controller: null,
    controllerMinThreshold: 0,
    manifestHash: 'a'.repeat(64),
    effectiveAt: 1_699_000_000,
    maturedBeforeClaim: true,
    ...over,
  };
}

function bundle(over: Partial<GovernanceEvidenceBundle> = {}): GovernanceEvidenceBundle {
  return {
    version: GOVERNANCE_BUNDLE_VERSION,
    stage: 'verify',
    triggerType: 4,
    txSignature: 'Sig',
    agentAddress: AGENT,
    holderAddress: HOLDER,
    coverageRaw: COVERAGE_RAW,
    slot: 200_000,
    blockTime: 1_700_000_000,
    hasRawTx: true,
    baseline: baseline(),
    authority: authority(),
    exposure: exposure(),
    signatures: signatures(),
    prices: [],
    windows: {},
    collectedAt: 1_700_000_100_000,
    ...over,
  };
}

describe('governance adjudicator — confirms', () => {
  it('confirms a seizure by a key outside the declared set', () => {
    const verdict = adjudicateGovernance(bundle());

    expect(verdict.outcome).toBe('confirmed');
    expect(verdict.reason).toBe('control_seized');
    expect(verdict.lossAmount).toBe(50_000 * 10 ** 6);
  });

  it('confirms a freeze, where no value moved at all', () => {
    const verdict = adjudicateGovernance(
      bundle({
        authority: authority({
          takeovers: [takeover({ kind: 'freeze', newAuthority: ATTACKER })],
        }),
        exposure: exposure({
          shape: 'freeze',
          goneValueUsd: 0,
          frozenValueUsd: 50_000,
          exposureUsd: 50_000,
        }),
        signatures: signatures({ present: ['account_frozen'], score: 0.3 }),
      }),
    );

    expect(verdict.outcome).toBe('confirmed');
    expect(verdict.lossAmount).toBe(50_000 * 10 ** 6);
  });

  it('caps the payout at the coverage', () => {
    const verdict = adjudicateGovernance(
      bundle({ exposure: exposure({ exposureUsd: 5_000_000, goneValueUsd: 5_000_000 }) }),
    );

    expect(verdict.lossAmount).toBe(COVERAGE_RAW);
  });

  it('never reaches the auto-pay bar on off-chain evidence alone', () => {
    // The structural guarantee: paying always needs the chain's own reading.
    const verdict = adjudicateGovernance(
      bundle({
        exposure: exposure({ confUsd: 0, exposureRatio: 0.99 }),
        signatures: signatures({ score: 1.5 }),
        authority: authority({
          ownerChanges: [
            {
              account: AGENT_USDC_ATA,
              mint: USDC,
              fromOwner: AGENT,
              toOwner: ATTACKER,
              amountRaw: 50_000e6,
            },
          ],
        }),
      }),
    );

    expect(verdict.confidence).toBeLessThanOrEqual(CONFIDENCE_CEILING);
    expect(verdict.confidence).toBeLessThan(AUTO_PAY_CONFIDENCE);
  });
});

describe('governance adjudicator — rejects only on positive facts', () => {
  it('rejects a reverted transaction', () => {
    const verdict = adjudicateGovernance(bundle({ authority: authority({ failed: true }) }));

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('transaction_failed');
  });

  it('rejects a rotation to an address the holder declared', () => {
    const verdict = adjudicateGovernance(
      bundle({
        authority: authority({
          takeovers: [takeover({ newAuthority: OPERATOR, signer: HOLDER, signerIsHolder: true })],
        }),
      }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('authority_within_baseline');
  });

  it('does not let a declared delegate become the account owner', () => {
    // The baseline PDA is public. Flattening the five declared roles into one
    // membership set meant an attacker could read the declared *delegate* and
    // name it as the new *owner* — landing the seizure inside the declared set
    // and getting it rejected, which is terminal and never seen by a human.
    const verdict = adjudicateGovernance(
      bundle({
        baseline: baseline({
          authorities: [AGENT, HOLDER, OPERATOR],
          extraAuthorities: [],
          expectedDelegate: OPERATOR,
        }),
        authority: authority({
          takeovers: [takeover({ kind: 'owner', newAuthority: OPERATOR })],
        }),
      }),
    );

    expect(verdict.outcome).not.toBe('rejected');
    expect(verdict.details.outsideDeclaredSet).toEqual([OPERATOR]);
  });

  it('still permits a declared delegate to hold a delegate allowance', () => {
    const verdict = adjudicateGovernance(
      bundle({
        baseline: baseline({
          authorities: [AGENT, HOLDER, OPERATOR],
          extraAuthorities: [],
          expectedDelegate: OPERATOR,
        }),
        authority: authority({
          takeovers: [
            takeover({
              kind: 'delegate',
              newAuthority: OPERATOR,
              signer: HOLDER,
              signerIsHolder: true,
            }),
          ],
        }),
      }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('authority_within_baseline');
  });

  it('rejects a rotation between the agent and the holder', () => {
    const verdict = adjudicateGovernance(
      bundle({
        authority: authority({
          takeovers: [takeover({ newAuthority: HOLDER, signer: AGENT, signerIsAgent: true })],
        }),
      }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('self_rotation');
  });

  it('rejects a takeover with nothing of value behind it', () => {
    const verdict = adjudicateGovernance(
      bundle({
        exposure: exposure({ exposureUsd: 0, goneValueUsd: 0, frozenValueUsd: 0, shape: 'none' }),
      }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('no_measurable_exposure');
  });

  it('rejects a loss below the dust floor', () => {
    const verdict = adjudicateGovernance(
      bundle({ exposure: exposure({ exposureUsd: 0.05, goneValueUsd: 0.05 }) }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('loss_below_dust');
    expect(verdict.details.floor).toBe(MIN_PAYABLE_LOSS_RAW);
  });

  it('rejects an undeclared rotation the holder signed, with nothing corroborating', () => {
    const verdict = adjudicateGovernance(
      bundle({
        authority: authority({
          holderWasSigner: true,
          takeovers: [takeover({ signer: HOLDER, signerIsHolder: true })],
        }),
        signatures: signatures({ score: 0.2, present: ['authority_left_manifest'] }),
      }),
    );

    expect(verdict.outcome).toBe('rejected');
    expect(verdict.reason).toBe('principal_authorised_change');
  });
});

describe('governance adjudicator — escalates rather than guessing', () => {
  it('escalates when no baseline has been declared', () => {
    // The state every policy is in before the mechanism ships. The absence of
    // a declaration is our gap, not the holder's consent.
    const verdict = adjudicateGovernance(bundle({ baseline: null }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('no_governance_baseline');
  });

  it('tells an outage apart from an absent declaration', () => {
    const verdict = adjudicateGovernance(bundle({ baseline: undefined }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('baseline_lookup_unavailable');
  });

  it('refuses a baseline that had not matured when the claim was filed', () => {
    const verdict = adjudicateGovernance(
      bundle({ baseline: baseline({ maturedBeforeClaim: false }) }),
    );

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('governance_baseline_not_matured');
  });

  it('escalates without the chain’s own record', () => {
    const verdict = adjudicateGovernance(bundle({ hasRawTx: false }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('no_chain_record');
  });

  it('escalates a loss it cannot place inside the window', () => {
    const verdict = adjudicateGovernance(bundle({ exposure: exposure({ withinWindow: false }) }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('conjunction_outside_window');
  });

  it('escalates an undeclared rotation the holder signed when the shape looks wrong', () => {
    // A stolen holder key signs exactly like the holder. Neither paying nor
    // denying is honest here.
    const verdict = adjudicateGovernance(
      bundle({
        authority: authority({
          holderWasSigner: true,
          takeovers: [takeover({ signer: HOLDER, signerIsHolder: true })],
        }),
        signatures: signatures({ score: 0.75 }),
      }),
    );

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('authorised_signer_anomalous');
  });

  it('escalates when the exposure could not be priced', () => {
    const verdict = adjudicateGovernance(bundle({ exposure: undefined }));

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('exposure_not_valued');
  });

  it('escalates when no authorization-class check could establish a takeover', () => {
    const verdict = adjudicateGovernance(
      bundle({ signatures: signatures({ hasAuthorizationEvidence: false, present: [] }) }),
    );

    expect(verdict.outcome).toBe('indeterminate');
    expect(verdict.reason).toBe('no_authorization_evidence');
  });
});

describe('governance adjudicator — purity', () => {
  it('returns an identical verdict for an identical bundle', () => {
    const b = bundle();
    const first = adjudicateGovernance(b);
    const second = adjudicateGovernance(b);

    const hash = bundleHash(b as unknown as Record<string, unknown>);
    expect(verdictHash(hash, first)).toBe(verdictHash(hash, second));
  });

  it('is insensitive to when the evidence was collected', () => {
    const now = adjudicateGovernance(bundle({ collectedAt: 1 }));
    const later = adjudicateGovernance(bundle({ collectedAt: 9_999_999_999 }));

    expect(later).toEqual(now);
  });

  it('publishes a version so a rules change is visible rather than silent', () => {
    expect(GOVERNANCE_ADJUDICATOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
