import type { RawTxView } from '../exploit/raw-tx.js';
import { analyseAuthority, type AuthorityReport, type Takeover } from './authority.js';

/**
 * Cheap screen for transactions worth a full governance verification.
 *
 * This exists because the detector for this trigger did not. Nothing in
 * production ever raised `governance_attack`: the only producer was the demo
 * endpoint, gated by `NODE_ENV`. The protocol sold the coverage and had no
 * way to notice the event.
 *
 * Same failure direction as the exploit screen, and for the same reason:
 *
 *   **Detection fails open; settlement fails closed.**
 *
 * A false alarm costs one verification. A miss costs the policyholder their
 * claim, permanently and silently.
 *
 * ---
 *
 * **Why there is no enhanced-payload variant, stated once so nobody adds one
 * by reflex.** The exploit screen has both a `RawTxView` and a Helius
 * `EnhancedTransaction` form, because a drain is visible in transfer amounts
 * and the indexer reports those. Nothing this screen looks for is in the
 * indexer payload: it carries no decoded instruction types, no per-side token
 * account owners, and no signer flags. The two ways to build one anyway are
 * both worse than not having it:
 *
 *   - Hand-decode `instructions[].data` to recover the SPL-Token opcode. The
 *     codebase deliberately does not do this anywhere — see the note at the
 *     top of `exploit/raw-tx.ts` — precisely so there is no binary decoder to
 *     maintain against Token-2022.
 *   - Flag on "the token program was invoked with no outgoing transfer",
 *     which is decode-free but fires on every ATA creation. Detection failing
 *     open is a principle about *evidence*, not a licence to flood the review
 *     queue with account setup.
 *
 * So the governance detector is the pull path — `exploit-watcher`, which
 * already fetches the `RawTxView` per transaction and can therefore run this
 * for free — plus the authority-checkpoint diff as its backstop. The cost is
 * detection latency bounded by the sweep interval rather than by webhook
 * delivery, which for a takeover is the right trade: the claim stays valid
 * for the life of the policy, so finding it two minutes late costs far less
 * than never finding it.
 */

export interface GovernanceScreenResult {
  flagged: boolean;
  severity: 'warning' | 'critical';
  reason: string;
  detail: Record<string, unknown>;
}

const NOT_FLAGGED: GovernanceScreenResult = {
  flagged: false,
  severity: 'warning',
  reason: 'no_governance_shape',
  detail: {},
};

export interface GovernanceScreenOptions {
  holderAddress?: string;
  /**
   * The authority set the holder declared as legitimate, once
   * `declare_governance_baseline` is deployed. Absent, the screen falls back
   * to "the agent and the holder are the legitimate set", which is the right
   * default and a strictly wider net.
   */
  baselineAuthorities?: string[];
}

/**
 * Screen the chain's own record of a transaction for a takeover.
 *
 * The question is narrow and structural: did control of something the agent
 * held move to somebody outside the legitimate set? Magnitude is deliberately
 * not part of it. Losing control of an account is not a matter of degree, and
 * the freeze case moves no value at all.
 */
export function screenRawTxForGovernance(
  view: RawTxView,
  agentAddress: string,
  options: GovernanceScreenOptions = {},
): GovernanceScreenResult {
  // A reverted transaction transferred no authority. This is the one cheap
  // negative that rests on a fact rather than an absence.
  if (view.err !== null && view.err !== undefined) return NOT_FLAGGED;

  const report = analyseAuthority({ view, agentAddress, holderAddress: options.holderAddress });
  const legitimate = new Set<string>([agentAddress, ...(options.baselineAuthorities ?? [])]);
  if (options.holderAddress) legitimate.add(options.holderAddress);

  // Read from the balance snapshots, so it survives an opaque program doing
  // the reassignment through a CPI the RPC never decoded. This is checked
  // first because it is the shape that needs no instruction at all.
  const foreignOwnerChanges = report.ownerChanges.filter(
    (c) => c.toOwner === null || !legitimate.has(c.toOwner),
  );
  if (foreignOwnerChanges.length > 0) {
    return {
      flagged: true,
      severity: 'critical',
      reason: 'account_ownership_seized',
      detail: {
        changes: foreignOwnerChanges,
        agentWasSigner: report.agentWasSigner,
        ...unevaluatedDetail(report),
      },
    };
  }

  const foreign = report.takeovers.filter(
    (t) => t.newAuthority === null || !legitimate.has(t.newAuthority),
  );
  if (foreign.length > 0) {
    return {
      flagged: true,
      severity: severityFor(foreign),
      reason: reasonFor(foreign),
      detail: {
        takeovers: foreign,
        agentWasSigner: report.agentWasSigner,
        holderWasSigner: report.holderWasSigner,
        ...unevaluatedDetail(report),
      },
    };
  }

  // A control change that stayed inside the legitimate set is a rotation, not
  // a takeover. It is still worth surfacing when *nobody entitled to make it*
  // signed: a third party moving control between two addresses the holder
  // happens to trust is not routine, whatever the destination.
  //
  // The holder signing is explicitly not enough to raise. Rotating the
  // agent's authority to a declared operator is the ordinary way a fleet is
  // run, and flagging it would mean every key rotation lands in the review
  // queue — which trains people to clear the queue without reading it.
  if (report.takeovers.length > 0 && !report.agentWasSigner && !report.holderWasSigner) {
    return {
      flagged: true,
      severity: 'warning',
      reason: 'control_change_without_authorised_signature',
      detail: {
        takeovers: report.takeovers,
        note:
          'Control moved within the legitimate set, but neither the agent nor the holder ' +
          'signed for it.',
        ...unevaluatedDetail(report),
      },
    };
  }

  // A multisig config change the RPC could not decode. It is not evidence of
  // a takeover, and it is emphatically not evidence of the absence of one —
  // so it raises at warning and the verifier reports it as unevaluated rather
  // than pretending to have checked.
  const opaque = report.unevaluated.filter((u) => u.check === 'multisig_config');
  if (opaque.length > 0) {
    return {
      flagged: true,
      severity: 'warning',
      reason: 'opaque_control_program',
      detail: { unevaluated: opaque },
    };
  }

  return NOT_FLAGGED;
}

/** A seizure or a freeze is unambiguous; an allowance might be routine. */
function severityFor(takeovers: Takeover[]): 'warning' | 'critical' {
  const decisive = takeovers.some(
    (t) => t.kind === 'owner' || t.kind === 'freeze' || t.kind === 'upgrade',
  );
  return decisive ? 'critical' : 'warning';
}

function reasonFor(takeovers: Takeover[]): string {
  // Most specific first, on the same principle as the monitor's anomaly
  // ordering: the strongest statement available about the incident should be
  // the one the claim carries.
  for (const kind of ['owner', 'freeze', 'upgrade', 'close', 'delegate'] as const) {
    if (takeovers.some((t) => t.kind === kind)) return `foreign_${kind}_authority`;
  }
  return 'foreign_authority';
}

function unevaluatedDetail(report: AuthorityReport): Record<string, unknown> {
  return report.unevaluated.length > 0 ? { unevaluated: report.unevaluated } : {};
}
