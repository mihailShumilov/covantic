import type { EvidenceStage, PricePoint, PriceWindow } from '../oracle/types.js';
import type { AuthorityReport } from './authority.js';
import type { GovernanceExposure } from './conjunction.js';
import type { GovernanceSignatureReport } from './signatures.js';

/**
 * The authority set the holder declared as legitimate, as read from chain.
 *
 * This is the thing that makes a governance verdict different in kind from
 * the other three triggers. An exploit verdict has to *infer* whether the agent
 * consented to funds moving; a price verdict has to *assert* what a swap
 * executed at. Here the holder said, in advance and under their own
 * signature, who is allowed to control the agent — so "was this authorised"
 * stops being an inference and becomes a set membership test.
 *
 * `null` for the whole record means no declaration exists. That is a gap in
 * our records, **not consent**, and the adjudicator treats it as
 * `indeterminate` rather than reading it either way.
 */
export interface GovernanceBaselineView {
  /**
   * Every address the holder declared, flattened.
   *
   * Retained for the audit trail and for `extraAuthorities`-style checks that
   * genuinely are role-agnostic. **Not** the right set for deciding whether a
   * given takeover was permitted: a declared *delegate* is not thereby
   * permitted to become the account's *owner*. Use {@link permittedFor}.
   */
  authorities: string[];
  /**
   * Operator keys the holder declared without binding them to one role.
   * These are permitted for any takeover kind, which is what makes them
   * distinct from the named single-role fields below.
   *
   * Optional: a bundle stored before the role-aware check existed carries no
   * such field, and must still replay rather than throw.
   */
  extraAuthorities?: string[];
  tokenOwner: string;
  expectedDelegate: string | null;
  expectedCloseAuthority: string | null;
  programUpgradeAuthority: string | null;
  controller: string | null;
  controllerMinThreshold: number;
  /** sha256 of the off-chain manifest the on-chain record commits to. */
  manifestHash: string;
  /** When the declaration became usable as proof. */
  effectiveAt: number;
  /**
   * The declaration matured *before* the incident it is being used to judge.
   *
   * Without this a compromised holder key could declare a fresh baseline and
   * claim against it in the same breath. The delay is what forces an attacker
   * to pre-commit, on chain, an hour early.
   */
  maturedBeforeClaim: boolean;
}

/**
 * Everything a governance verdict is allowed to rest on, and nothing else.
 *
 * Same contract as the price and exploit bundles, for the same reason: **all
 * network I/O happens while building this; the adjudication that reads it is
 * a pure function.** A payout nobody can re-derive is a payout nobody can
 * audit.
 *
 * Fields are optional so an older bundle stays replayable against a newer
 * adjudicator. The adjudicator must degrade to `indeterminate` on missing
 * inputs rather than guess.
 */
export interface GovernanceEvidenceBundle {
  /** Bundle schema version. Bump on any shape change. */
  version: string;
  stage: EvidenceStage;

  /** Always {@link TriggerType.GovernanceAttack}. Carried so a replay can
   *  dispatch without consulting the claim row. */
  triggerType: number;
  txSignature: string;
  agentAddress: string;
  holderAddress?: string;
  coverageRaw: number;

  slot: number | null;
  blockTime: number | null;
  /** Set when the indexer and the RPC disagreed about the block time. */
  blockTimeDisagreementSec?: number;

  /** Whether the chain's own record was available. Signer flags and per-side
   *  token account owners live only there, and both are load-bearing. */
  hasRawTx: boolean;

  /**
   * The declared set. `undefined` means the lookup never ran; `null` means it
   * ran and found no declaration. The adjudicator distinguishes them because
   * one is an outage and the other is a policy that predates the mechanism.
   */
  baseline?: GovernanceBaselineView | null;

  /** Who controls what, before and after. */
  authority?: AuthorityReport;
  /** What the change cost, and whether it landed inside the window. */
  exposure?: GovernanceExposure;
  /** Structural evidence separating a takeover from an operation. */
  signatures?: GovernanceSignatureReport;
  /** Programs invoked, for the audit trail. Not a verdict input — that
   *  mistake is what the old verifier was built entirely out of. */
  programs?: Record<string, unknown>;

  /** Price observations consulted while valuing the exposure, and the
   *  bracketing windows they came from. Kept so a replay re-derives the
   *  valuation without re-fetching. */
  prices: PricePoint[];
  windows: Record<string, PriceWindow>;

  /**
   * Wall-clock capture time. **Excluded from the bundle hash** — provenance,
   * not evidence, and including it would make every replay hash differently.
   */
  collectedAt: number;
}

/** Bump on any change to the bundle's shape. */
export const GOVERNANCE_BUNDLE_VERSION = '1.0.0';
