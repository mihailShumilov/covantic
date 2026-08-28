import { CONFIDENCE_CEILING } from '../confidence-lanes.js';
import type { AuthorityReport, TakeoverKind } from './authority.js';
import type { GovernanceExposure } from './conjunction.js';
import type { GovernanceSignatureReport } from './signatures.js';
import type { GovernanceBaselineView, GovernanceEvidenceBundle } from './types.js';

/**
 * The judgement, separated from the evidence gathering.
 *
 * Nothing in this file performs I/O, reads a clock, or generates randomness.
 * The contract is exact: `adjudicateGovernance(bundle)` returns the same
 * verdict for the same bundle, forever, for anyone holding it.
 * `pnpm claim:replay` relies on it and the on-chain evidence hash commits
 * to it.
 *
 * When the rules genuinely change, bump {@link GOVERNANCE_ADJUDICATOR_VERSION}
 * rather than quietly altering behaviour.
 *
 * ---
 *
 * **The shape of the decision, which is not the one the old verifier made.**
 *
 * The old rule was: *a governance program appeared in the transaction and
 * some balance moved → pay half the coverage.* Both halves were wrong. The
 * covered subject is an agent wallet, not a DAO, so a real takeover — a
 * `SetAuthority` against the agent's own accounts — invoked no governance
 * program and was rejected; while a routine Realms vote next to a rent
 * payment was confirmed. And the payout was a fixed fraction that measured
 * nothing about the incident.
 *
 * The rule here is: *control over something the agent held left the set the
 * holder declared, somebody other than the holder or the agent exercised it,
 * and it cost something.*
 *
 * **The limit of that, stated once so nobody has to discover it.** The chain
 * can show that control left the declared set and that the new controller is
 * neither the holder nor the agent. It cannot show that the new controller is
 * not a *second wallet the holder also owns*. That residual is the same one
 * the exploit path carries with destination control, and this module does not
 * pretend otherwise — what it adds is that a fraudulent claim now requires
 * the holder to have signed a manifest an hour before the incident and left
 * it on chain, which is a materially harder lie than moving your own money
 * and calling it a drain.
 */

/** Bump on any change that alters what this function decides. */
export const GOVERNANCE_ADJUDICATOR_VERSION = '1.1.0';

export type Outcome = 'confirmed' | 'rejected' | 'indeterminate';

export interface GovernanceVerdict {
  outcome: Outcome;
  lossAmount: number;
  confidence: number;
  reason: string;
  details: Record<string, unknown>;
  retryAfterSec?: number;
}

/**
 * Smallest loss worth paying out, in USDC lamports (0.1 USDC).
 *
 * Filing a claim, locking the policy and writing an evidence record all cost
 * more than a smaller amount is worth.
 */
export const MIN_PAYABLE_LOSS_RAW = 100_000;

/**
 * Structural corroboration required before a control change the holder or the
 * agent apparently authorised is escalated rather than closed.
 *
 * Below this, "the holder rotated keys and forgot to update the manifest" is
 * the ordinary reading.
 */
export const REVIEW_SIGNATURE_SCORE = 0.4;

/**
 * Highest confidence reachable here.
 *
 * Below the auto-pay bar on purpose, and the consequence is deliberate:
 * off-chain analysis, however well corroborated, can never release funds on
 * its own. Releasing funds requires the chain's own reading of who controls
 * the account (`verify_and_payout_governance`). This ceiling is what makes
 * that structural rather than a policy someone can quietly relax.
 */
export { CONFIDENCE_CEILING } from '../confidence-lanes.js';

/**
 * Score a fully collected evidence bundle.
 *
 * Degrades to `indeterminate` on missing inputs rather than guessing, so an
 * older bundle replayed against a newer adjudicator produces "cannot tell"
 * instead of a confident answer built on absent evidence.
 */
export function adjudicateGovernance(bundle: GovernanceEvidenceBundle): GovernanceVerdict {
  const { authority, exposure, signatures, baseline } = bundle;

  if (!authority) {
    return indeterminate('incomplete_evidence_bundle', {
      hasAuthority: false,
      hasExposure: exposure !== undefined,
      bundleVersion: bundle.version,
    });
  }

  // Signer flags and per-side token account owners are unanswerable from the
  // indexer payload, and both are facts this verdict turns on.
  if (!bundle.hasRawTx) {
    return indeterminate(
      'no_chain_record',
      {
        note:
          'Only the indexer payload was available. It carries no signer flags and no token ' +
          'account owners, so neither who exercised the authority nor whether ownership ' +
          'changed can be established from it.',
      },
      120,
    );
  }

  if (authority.failed) {
    // A reverted transaction transferred no authority. This is a fact about
    // the chain's record, not an absence of evidence, so it closes the claim.
    return rejected('transaction_failed', {
      note: 'Transaction reverted; control did not change hands.',
    });
  }

  // The declared set has to exist and has to predate the incident. Neither
  // failure is the claimant's fault and neither is evidence against them.
  if (baseline === undefined) {
    return indeterminate(
      'baseline_lookup_unavailable',
      { note: 'The on-chain governance baseline could not be read.' },
      300,
    );
  }
  if (baseline === null) {
    return indeterminate(
      'no_governance_baseline',
      {
        note:
          'No governance baseline has been declared for this policy. Without a set the holder ' +
          'signed for, "the authority changed" cannot be told apart from "the holder rotated ' +
          'keys" — and the absence of a declaration is a gap in our records, not consent.',
      },
      1_800,
    );
  }
  if (!baseline.maturedBeforeClaim) {
    return indeterminate(
      'governance_baseline_not_matured',
      {
        effectiveAt: baseline.effectiveAt,
        note:
          'The declaration had not matured when the incident was filed. A baseline that can ' +
          'be created and claimed against in the same breath proves nothing.',
      },
      1_800,
    );
  }

  const declared = new Set([
    ...baseline.authorities,
    bundle.agentAddress,
    ...(bundle.holderAddress ? [bundle.holderAddress] : []),
  ]);
  const controllers = controllersOf(authority);
  const outside = outsideDeclaredSet(authority, baseline, bundle);
  // A control change whose new owner the RPC did not report. Everywhere else
  // in this pipeline an unreported owner is treated as maximally suspicious
  // (`hasForeignTakeover`, the prefilter); dropping it here silently turned a
  // visible seizure into `no_control_change` — a rejection, which is terminal.
  const unattributedControlChanges =
    authority.takeovers.filter((t) => !t.newAuthority).length +
    authority.ownerChanges.filter((c) => c.toOwner === null).length;

  const facts = {
    controllers,
    outsideDeclaredSet: outside,
    declaredSetSize: declared.size,
    takeoverKinds: authority.takeovers.map((t) => t.kind),
    ownerChanges: authority.ownerChanges.length,
    unattributedControlChanges,
    agentWasSigner: authority.agentWasSigner,
    holderWasSigner: authority.holderWasSigner,
    manifestHash: baseline.manifestHash,
    signatureScore: signatures?.score ?? null,
    signaturesPresent: signatures?.present ?? [],
    signaturesUnevaluated: signatures?.unevaluated ?? [],
    slot: bundle.slot,
    blockTime: bundle.blockTime,
  };

  if (controllers.length === 0) {
    // One exception, and it is the difference between "we checked" and "we
    // looked at something we cannot read". When the holder declared a
    // multisig controller and a multisig program the RPC cannot decode was
    // invoked, a threshold change is neither ruled in nor ruled out — and
    // rejecting would be a statement that the evidence contradicts the claim.
    const opaqueControl = authority.unevaluated.filter((u) => u.check === 'multisig_config');
    if (baseline.controller !== null && opaqueControl.length > 0) {
      return indeterminate(
        'multisig_config_unevaluated',
        {
          ...facts,
          controller: baseline.controller,
          declaredMinThreshold: baseline.controllerMinThreshold,
          unevaluated: opaqueControl,
          note:
            'This policy declares a multisig controller, and a multisig program was invoked ' +
            'whose instructions the RPC does not decode. Whether the controller was weakened ' +
            'cannot be established here.',
        },
        1_800,
      );
    }

    if (unattributedControlChanges > 0) {
      return indeterminate(
        'unattributed_control_change',
        {
          ...facts,
          note:
            'Control of the agent’s account changed, but the RPC did not report to whom. ' +
            'That is a gap in what we could read, not evidence the claim is false.',
        },
        1_800,
      );
    }

    return rejected('no_control_change', {
      ...facts,
      note: 'Nothing the agent controlled changed hands.',
      // Recorded even when it does not change the outcome: an undecodable
      // program next to a policy with no declared controller is irrelevant to
      // the covered account, but a reviewer should still see it was there.
      opaqueControlPrograms: opaqueControl.length,
    });
  }

  if (outside.length === 0) {
    // The clean rejection, and it rests on a positive on-chain fact: control
    // is exactly where the holder said it should be.
    const selfOnly = controllers.every(
      (c) => c === bundle.agentAddress || c === bundle.holderAddress,
    );
    return rejected(selfOnly ? 'self_rotation' : 'authority_within_baseline', {
      ...facts,
      note: selfOnly
        ? 'Control moved between the agent and the holder. It never left the family.'
        : 'Control moved to an address the holder declared as legitimate before the incident.',
    });
  }

  if (!exposure) {
    return indeterminate(
      'exposure_not_valued',
      {
        ...facts,
        note:
          'Control left the declared set, but what it cost could not be priced — an ' +
          'unregistered mint, a silent feed, or sources that disagreed. Refusing to guess ' +
          'at the size of the loss.',
      },
      600,
    );
  }

  if (!exposure.withinWindow) {
    return indeterminate(
      'conjunction_outside_window',
      {
        ...facts,
        exposureUsd: exposure.exposureUsd,
        windowSec: exposure.windowSec,
        measuredFrom: exposure.measuredFromBlockTime,
        measuredTo: exposure.measuredToBlockTime,
        note:
          'The readings bounding the loss do not sit inside the covered window. The loss may ' +
          'well be real and may well be this takeover’s doing; it is simply not provable as ' +
          'a conjunction from readings this far apart, so a human decides.',
      },
      1_800,
    );
  }

  if (!(exposure.exposureUsd > 0)) {
    return rejected('no_measurable_exposure', {
      ...facts,
      note:
        'Control changed hands and nothing of value was behind it — the accounts were empty ' +
        'and nothing left in the window.',
    });
  }

  const lossAmount = capToCoverage(usdToRaw(exposure.exposureUsd), bundle.coverageRaw);
  if (lossAmount < MIN_PAYABLE_LOSS_RAW) {
    return rejected('loss_below_dust', {
      ...facts,
      lossAmount,
      floor: MIN_PAYABLE_LOSS_RAW,
    });
  }

  if (!signatures) {
    return indeterminate('no_signature_report', { ...facts }, 600);
  }

  // The decisive fork.
  if (principalSigned(authority)) {
    // The holder or the agent signed for this themselves. Either they rotated
    // control somewhere they had not declared, or their key was stolen — and
    // no evidence available here separates those. Corroboration decides
    // whether the ambiguity is worth a human.
    if (signatures.score >= REVIEW_SIGNATURE_SCORE) {
      return indeterminate(
        'authorised_signer_anomalous',
        {
          ...facts,
          threshold: REVIEW_SIGNATURE_SCORE,
          note:
            'Control left the declared set under the holder’s or the agent’s own signature, ' +
            'yet the surrounding shape looks like a takeover. A stolen key signs exactly ' +
            'like its owner, so this is escalated rather than paid or denied.',
        },
        1_800,
      );
    }
    return rejected('principal_authorised_change', {
      ...facts,
      threshold: REVIEW_SIGNATURE_SCORE,
      note:
        'The holder or the agent signed for the change and nothing structural contradicts ' +
        'that. An undeclared rotation is a stale manifest, not a claim.',
    });
  }

  if (!signatures.hasAuthorizationEvidence) {
    return indeterminate(
      'no_authorization_evidence',
      {
        ...facts,
        note:
          'Control sits outside the declared set, but no check in the authorization class ' +
          'could establish that it was taken rather than handed over.',
      },
      600,
    );
  }

  return {
    outcome: 'confirmed',
    lossAmount,
    confidence: scoreConfidence(bundle, exposure, signatures, authority),
    reason: 'control_seized',
    details: {
      reason: 'control_seized',
      ...facts,
      exposureUsd: exposure.exposureUsd,
      goneValueUsd: exposure.goneValueUsd,
      frozenValueUsd: exposure.frozenValueUsd,
      exposureShape: exposure.shape,
    },
  };
}

/**
 * Confidence in the verdict, not in the loss.
 *
 * The budget is lopsided on purpose, exactly as on the exploit path. How
 * *much* was lost contributes almost nothing; how well established it is that
 * control was taken rather than handed over contributes most.
 */
function scoreConfidence(
  bundle: GovernanceEvidenceBundle,
  exposure: GovernanceExposure,
  signatures: GovernanceSignatureReport,
  authority: AuthorityReport,
): number {
  let confidence = 0.55;

  // Structural corroboration beyond the authorization finding itself.
  confidence += Math.min(0.25, signatures.score * 0.25);

  // Each check that could not run is a hole in the picture. Counted across
  // both panels: an undecodable Squads instruction is a hole whether it is
  // reported by the forensics or by the signature that depends on it.
  const holes = signatures.unevaluated.length + authority.unevaluated.length;
  confidence -= Math.min(0.15, holes * 0.03);

  // A seizure or a freeze is the least ambiguous shape there is: the account
  // is demonstrably not the agent's to use any more.
  if (authority.ownerChanges.length > 0) confidence += 0.05;
  if (exposure.frozenValueUsd > 0) confidence += 0.05;

  // A measured ratio is direct evidence of scale; its absence is not evidence
  // of anything, so it is a bonus rather than a penalty.
  if (exposure.exposureRatio !== null && exposure.exposureRatio >= 0.5) confidence += 0.05;
  else if (exposure.exposureRatio === null) confidence -= 0.03;

  // Uncertainty in the reference prices the exposure was measured with.
  const confFraction = exposure.exposureUsd > 0 ? exposure.confUsd / exposure.exposureUsd : 0;
  confidence -= Math.min(0.1, confFraction * 2);

  if ([...exposure.gone, ...exposure.frozen].some((l) => l.parFallback)) confidence -= 0.03;
  if (bundle.blockTimeDisagreementSec !== undefined && bundle.blockTimeDisagreementSec > 2) {
    confidence -= 0.05;
  }

  return Math.max(0, Math.min(CONFIDENCE_CEILING, Number(confidence.toFixed(4))));
}

/**
 * Did the holder or the agent sign for every change of control?
 *
 * Deliberately strict about the case where no instruction was decoded at all:
 * an account that changed owner through an opaque CPI counts as
 * principal-signed only when a principal actually signed the transaction.
 */
function principalSigned(authority: AuthorityReport): boolean {
  const changed = authority.takeovers.length > 0 || authority.ownerChanges.length > 0;
  if (!changed) return false;
  if (!authority.takeovers.every((t) => t.signerIsAgent || t.signerIsHolder)) return false;
  if (
    authority.ownerChanges.length > 0 &&
    !authority.agentWasSigner &&
    !authority.holderWasSigner
  ) {
    return false;
  }
  return true;
}

/**
 * Which new controllers the holder's declaration does *not* account for.
 *
 * Role-aware on purpose. A declaration names five distinct capabilities —
 * who owns the account, who may hold an allowance against it, who may close
 * it, who may upgrade the program, who controls it via multisig — and
 * flattening them into one membership test says that declaring an address for
 * any one of them declares it for all five.
 *
 * That is a targeted evasion, not a theoretical one: the baseline PDA is
 * public, so an attacker able to issue `SetAuthority(AccountOwner)` can read
 * the declared *delegate* and name it as the new owner. Under a flat test the
 * seizure lands inside the declared set and is `rejected` — terminal, with no
 * human review. Keyed by kind, it lands outside and is confirmed.
 *
 * `extraAuthorities` are the deliberate exception: operator keys the holder
 * declared without binding them to a role, so they are permitted for any kind.
 */
function permittedFor(
  kind: TakeoverKind,
  baseline: GovernanceBaselineView,
  bundle: GovernanceEvidenceBundle,
): Set<string> {
  // Absent `extraAuthorities` means a bundle stored before this check existed.
  // Falling back to the flat set reproduces the old verdict exactly, which is
  // what `claim:replay` requires of historical evidence; bundles built by the
  // current reader always carry the field (empty array included), so the
  // role-aware check governs every new claim.
  const roleAgnostic = baseline.extraAuthorities ?? baseline.authorities;
  const base = [
    bundle.agentAddress,
    ...(bundle.holderAddress ? [bundle.holderAddress] : []),
    ...roleAgnostic,
  ];
  switch (kind) {
    case 'owner':
    case 'freeze':
      // A freeze is exercised by the account's own authority, so it shares the
      // owner's set rather than having one of its own.
      return new Set([...base, baseline.tokenOwner]);
    case 'delegate':
      return new Set([...base, ...(baseline.expectedDelegate ? [baseline.expectedDelegate] : [])]);
    case 'close':
      return new Set([
        ...base,
        ...(baseline.expectedCloseAuthority ? [baseline.expectedCloseAuthority] : []),
      ]);
    case 'upgrade':
      return new Set([
        ...base,
        ...(baseline.programUpgradeAuthority ? [baseline.programUpgradeAuthority] : []),
      ]);
  }
}

function outsideDeclaredSet(
  authority: AuthorityReport,
  baseline: GovernanceBaselineView,
  bundle: GovernanceEvidenceBundle,
): string[] {
  const outside: string[] = [];
  for (const t of authority.takeovers) {
    if (!t.newAuthority) continue;
    if (!permittedFor(t.kind, baseline, bundle).has(t.newAuthority)) outside.push(t.newAuthority);
  }
  // A bare owner change carries no instruction to read a kind from; it is an
  // ownership transfer by definition.
  const ownerSet = permittedFor('owner', baseline, bundle);
  for (const c of authority.ownerChanges) {
    if (c.toOwner && !ownerSet.has(c.toOwner)) outside.push(c.toOwner);
  }
  return [...new Set(outside)].sort();
}

function controllersOf(authority: AuthorityReport): string[] {
  const controllers = [
    ...authority.takeovers.map((t) => t.newAuthority),
    ...authority.ownerChanges.map((c) => c.toOwner),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  return [...new Set(controllers)].sort();
}

function usdToRaw(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function capToCoverage(lossRaw: number, coverageRaw: number): number {
  if (lossRaw <= 0) return 0;
  return Math.min(Math.floor(lossRaw), coverageRaw);
}

function rejected(reason: string, details: Record<string, unknown>): GovernanceVerdict {
  return {
    outcome: 'rejected',
    lossAmount: 0,
    confidence: 0,
    reason,
    details: { reason, ...details },
  };
}

function indeterminate(
  reason: string,
  details: Record<string, unknown>,
  retryAfterSec = 600,
): GovernanceVerdict {
  return {
    outcome: 'indeterminate',
    lossAmount: 0,
    confidence: 0,
    reason,
    details: { reason, ...details },
    retryAfterSec,
  };
}
