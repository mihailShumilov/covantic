import { PublicKey, type Connection } from '@solana/web3.js';
import { logger } from '../../utils/logger.js';
import type { CohortHit, CohortLookup } from '../exploit/signatures.js';
import type { AuthorityReport, Takeover } from './authority.js';
import type { GovernanceExposure } from './conjunction.js';

/**
 * Structural evidence that control changing hands was an attack rather than
 * an operation.
 *
 * Control moving is not, by itself, a takeover. Key rotations, delegated
 * allowances to lending protocols, operator handovers and migrations all move
 * authority around. What separates them from a seizure is *shape*.
 *
 * The strongest signal by a wide margin is `authority_left_manifest`: the new
 * controller sits outside the set the holder signed for, in advance, on
 * chain. Nothing else here comes close, and the adjudicator will not confirm
 * without something from the authorization class present.
 *
 * The discipline inherited from the other two panels matters more than the
 * list does: **a check that could not run reports `present: null` and lands
 * in `unevaluated`, never `false`.** A Squads config change the RPC cannot
 * decode is not evidence that the threshold held.
 *
 * Note what is deliberately absent: "a governance program was invoked". That
 * was the entirety of the old verifier's test, and it establishes nothing —
 * the covered subject is an agent wallet, and a takeover of one is a
 * `SetAuthority` against its own accounts, which touches no DAO program at
 * all.
 */

export type GovernanceSignatureId =
  | 'authority_left_manifest'
  | 'takeover_signer_foreign'
  | 'account_frozen'
  | 'upgrade_authority_seized'
  | 'drain_follows_takeover'
  | 'victim_cohort'
  | 'multisig_config_opaque'
  | 'delegate_installed_then_pulled'
  | 'new_authority_first_seen';

export interface GovernanceSignatureFinding {
  id: GovernanceSignatureId;
  /** `null` means the check could not run — never conflate with "absent". */
  present: boolean | null;
  weight: number;
  detail: Record<string, unknown>;
}

export interface GovernanceSignatureReport {
  findings: GovernanceSignatureFinding[];
  present: GovernanceSignatureId[];
  unevaluated: Array<{ id: GovernanceSignatureId; reason: string }>;
  /** Summed weight of what was positively observed. */
  score: number;
  /** True when at least one signature in the authorization class fired. The
   *  adjudicator treats this as a hard requirement for the pay lanes. */
  hasAuthorizationEvidence: boolean;
}

/** Weights. Tuned so no single corroborating signal can carry a verdict on
 *  its own, and so the authorization class dominates everything else. */
export const GOVERNANCE_SIGNATURE_WEIGHTS: Record<GovernanceSignatureId, number> = {
  authority_left_manifest: 0.45,
  takeover_signer_foreign: 0.4,
  account_frozen: 0.3,
  upgrade_authority_seized: 0.3,
  drain_follows_takeover: 0.3,
  victim_cohort: 0.3,
  delegate_installed_then_pulled: 0.25,
  new_authority_first_seen: 0.2,
  // Weightless on purpose. An undecodable multisig instruction is a *gap*,
  // and a gap must never add to a score that argues for paying. It is carried
  // so the reviewer sees it and so the confidence penalty for unevaluated
  // checks applies.
  multisig_config_opaque: 0,
};

/** Signatures that establish control left the legitimate set. */
const AUTHORIZATION_CLASS: GovernanceSignatureId[] = [
  'authority_left_manifest',
  'takeover_signer_foreign',
  'account_frozen',
  'upgrade_authority_seized',
];

/** Transactions examined before the incident when judging a new authority. */
const HISTORY_TX_LIMIT = 25;

export interface GovernanceSignatureContext {
  authority: AuthorityReport;
  /** Null when holdings could not be valued; the drain check then reports
   *  unevaluated rather than assuming nothing was lost. */
  exposure: GovernanceExposure | null;
  /**
   * The authority set the holder declared, once the baseline is deployed.
   * `null` means no declaration exists — which is a gap in our records, not
   * consent, and `authority_left_manifest` reports unevaluated for it.
   */
  manifestAuthorities: string[] | null;
  agentAddress: string;
  holderAddress?: string;
  txSignature: string;
  blockTime: number;
  connection?: Connection | null;
  cohort?: CohortLookup;
}

/**
 * Run the panel.
 *
 * Every network-dependent check is individually guarded: an RPC failure costs
 * that one signature, reported as unevaluated, and never fails the collection
 * or silently reads as a negative.
 */
export async function collectGovernanceSignatures(
  ctx: GovernanceSignatureContext,
): Promise<GovernanceSignatureReport> {
  const findings: GovernanceSignatureFinding[] = [];
  const unevaluated: Array<{ id: GovernanceSignatureId; reason: string }> = [];

  const add = (
    id: GovernanceSignatureId,
    present: boolean | null,
    detail: Record<string, unknown>,
    reason?: string,
  ) => {
    findings.push({ id, present, weight: GOVERNANCE_SIGNATURE_WEIGHTS[id], detail });
    if (present === null) unevaluated.push({ id, reason: reason ?? 'not evaluated' });
  };

  const auth = ctx.authority;
  const newControllers = controllersOf(auth);

  // --- authorization class: free, and decisive ----------------------------
  if (ctx.manifestAuthorities === null) {
    add(
      'authority_left_manifest',
      null,
      { newControllers },
      'No governance baseline has been declared for this policy, so there is no declared ' +
        'set for the new controller to have left.',
    );
  } else {
    const declared = new Set([
      ...ctx.manifestAuthorities,
      ctx.agentAddress,
      ...(ctx.holderAddress ? [ctx.holderAddress] : []),
    ]);
    const outside = newControllers.filter((c) => !declared.has(c));
    add('authority_left_manifest', outside.length > 0, {
      outside,
      declared: [...declared].sort(),
      note: 'Control sits outside the set the holder signed for before the incident.',
    });
  }

  const foreignSigners = auth.takeovers
    .filter((t) => !t.signerIsAgent && !t.signerIsHolder)
    .map((t) => t.signer)
    .filter((s): s is string => s !== null);
  const unsignedOwnerChanges = auth.ownerChanges.length > 0 && !auth.agentWasSigner;
  add('takeover_signer_foreign', foreignSigners.length > 0 || unsignedOwnerChanges, {
    signers: [...new Set(foreignSigners)].sort(),
    agentWasSigner: auth.agentWasSigner,
    holderWasSigner: auth.holderWasSigner,
    ownerChanges: auth.ownerChanges.length,
    note: 'Whoever exercised the authority was neither the agent nor the holder.',
  });

  const freezes = auth.takeovers.filter((t) => t.kind === 'freeze' && !t.newAuthorityIsSelf);
  add('account_frozen', freezes.length > 0, {
    accounts: freezes.map((f) => ({ account: f.account, authority: f.newAuthority })),
    note: 'The balance never moves. The agent simply cannot use it any more.',
  });

  const upgrades = auth.takeovers.filter((t) => t.kind === 'upgrade' && !t.newAuthorityIsSelf);
  add('upgrade_authority_seized', upgrades.length > 0, {
    programs: upgrades.map((u) => ({ account: u.account, newAuthority: u.newAuthority })),
    note: 'Whoever holds a program’s upgrade authority controls everything it controls.',
  });

  // --- the conjunction -----------------------------------------------------
  if (!ctx.exposure) {
    add('drain_follows_takeover', null, {}, 'Holdings could not be valued.');
  } else if (!ctx.exposure.withinWindow) {
    add(
      'drain_follows_takeover',
      null,
      {
        exposureUsd: ctx.exposure.exposureUsd,
        measuredFrom: ctx.exposure.measuredFromBlockTime,
        measuredTo: ctx.exposure.measuredToBlockTime,
        windowSec: ctx.exposure.windowSec,
      },
      'The readings bounding the loss do not sit inside the covered window; the conjunction ' +
        'is not provable from them.',
    );
  } else {
    add('drain_follows_takeover', ctx.exposure.goneValueUsd > 0, {
      goneValueUsd: ctx.exposure.goneValueUsd,
      exposureRatio: ctx.exposure.exposureRatio,
      windowSec: ctx.exposure.windowSec,
      note: 'Value left inside the window that opened when control changed hands.',
    });
  }

  // --- allowance granted and immediately exercised -------------------------
  const delegates = auth.takeovers.filter((t) => t.kind === 'delegate' && !t.newAuthorityIsSelf);
  if (delegates.length === 0) {
    add('delegate_installed_then_pulled', false, {});
  } else if (!ctx.exposure) {
    add(
      'delegate_installed_then_pulled',
      null,
      { delegates: delegates.map((d) => d.newAuthority) },
      'An allowance was granted, but without a valuation it cannot be said whether it was drawn.',
    );
  } else {
    add('delegate_installed_then_pulled', ctx.exposure.goneValueUsd > 0, {
      delegates: delegates.map((d) => ({ delegate: d.newAuthority, amountRaw: d.amountRaw })),
      goneValueUsd: ctx.exposure.goneValueUsd,
      note: 'Granting an allowance and drawing it are two different events; both happened.',
    });
  }

  // --- the gap, carried rather than hidden ---------------------------------
  const opaque = auth.unevaluated.filter((u) => u.check === 'multisig_config');
  add(
    'multisig_config_opaque',
    opaque.length > 0 ? null : false,
    { programs: opaque.map((o) => o.reason) },
    opaque.length > 0 ? opaque[0]!.reason : undefined,
  );

  // --- network checks ------------------------------------------------------
  if (!ctx.connection) {
    add('new_authority_first_seen', null, {}, 'No RPC connection supplied.');
  } else if (newControllers.length === 0) {
    add('new_authority_first_seen', null, {}, 'No new controller address to look up.');
  } else {
    const result = await checkFirstSeen(ctx.connection, newControllers, ctx.txSignature);
    add('new_authority_first_seen', result.present, result.detail, result.reason);
  }

  if (!ctx.cohort) {
    add('victim_cohort', null, {}, 'No cohort lookup supplied.');
  } else {
    try {
      const hits: CohortHit[] = await ctx.cohort({
        counterparties: newControllers,
        programs: [...new Set(auth.takeovers.map((t) => t.invokedBy))],
        blockTime: ctx.blockTime,
        excludeAgent: ctx.agentAddress,
      });
      add('victim_cohort', hits.length > 0, {
        hits,
        note: 'One key sweeping several insured agents is not a coincidence of operations.',
      });
    } catch (err) {
      add(
        'victim_cohort',
        null,
        {},
        `Cohort lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const present = findings.filter((f) => f.present === true).map((f) => f.id);
  return {
    findings,
    present,
    unevaluated,
    score: Number(
      findings
        .filter((f) => f.present === true)
        .reduce((sum, f) => sum + f.weight, 0)
        .toFixed(4),
    ),
    hasAuthorizationEvidence: present.some((id) => AUTHORIZATION_CLASS.includes(id)),
  };
}

/** Every address that ended up holding some control the agent used to have. */
function controllersOf(auth: AuthorityReport): string[] {
  const controllers = [
    ...auth.takeovers.map((t: Takeover) => t.newAuthority),
    ...auth.ownerChanges.map((c) => c.toOwner),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  return [...new Set(controllers)].sort();
}

/**
 * Did the new controller exist before this transaction?
 *
 * An address created minutes before it takes over an account is a burner. One
 * with months of history is an operator.
 */
async function checkFirstSeen(
  connection: Connection,
  addresses: string[],
  signature: string,
): Promise<{ present: boolean | null; detail: Record<string, unknown>; reason?: string }> {
  const results: Array<{ address: string; priorTxCount: number }> = [];
  for (const address of addresses) {
    let key: PublicKey;
    try {
      key = new PublicKey(address);
    } catch {
      continue;
    }
    try {
      const prior = await connection.getSignaturesForAddress(key, {
        before: signature,
        limit: HISTORY_TX_LIMIT,
      });
      results.push({ address, priorTxCount: prior.length });
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : err, address },
        'governance signatures: authority history unavailable',
      );
      return {
        present: null,
        detail: { address },
        reason: 'RPC did not return history for the new authority.',
      };
    }
  }
  if (results.length === 0) {
    return { present: null, detail: {}, reason: 'No parseable authority address.' };
  }
  const fresh = results.filter((r) => r.priorTxCount === 0);
  return { present: fresh.length > 0, detail: { results, fresh: fresh.map((f) => f.address) } };
}
