import { CONFIDENCE_CEILING } from '../confidence-lanes.js';
import { MIN_PROVABLE_MANDATE_BREACH } from '@covantic/shared';
import type { AgentErrorEvidenceBundle } from './types.js';

/**
 * The judgement, separated from the evidence gathering.
 *
 * Nothing in this file performs I/O, reads a clock, or generates randomness.
 * The contract is exact: `adjudicateAgentError(bundle)` returns the same
 * verdict for the same bundle, forever, for anyone holding it. `pnpm
 * claim:replay` relies on it and the on-chain evidence hash commits to it.
 *
 * When the rules genuinely change, bump {@link AGENT_ERROR_ADJUDICATOR_VERSION}
 * rather than quietly altering behaviour.
 *
 * ---
 *
 * The shape of the decision, which is worth stating plainly because it is not
 * the one the previous verifier made.
 *
 * The old rule was: *a large outflow went through a program we do not
 * recognise → this is an agent error, pay it.* It confirmed at 0.6 for any
 * ≥1,000 USDC outflow through any program outside a ten-entry DEX list, at
 * 0.85 if a flash-loan program appeared, at 0.5 through a bridge — and
 * rejected outright whenever a DEX appeared. So it paid for ordinary deposits
 * into unfamiliar protocols and for bridge transfers to the holder's own
 * address, and denied a catastrophic misrouted swap through Jupiter. It also
 * approved a flat, invented 1 USDC for every reverted transaction, on the
 * grounds that fees are hard to convert.
 *
 * The rule here is: *the agent moved its own money, outside the envelope its
 * owner declared in advance, and did not get it back.*
 *
 * **Why it has to be built on a declaration, stated once.** An agent error is
 * a loss the agent caused with its *own* authority — precisely the case
 * `adjudicateExploit` rejects as `agent_authorized_movement`. Every forensic
 * trace says the agent meant it, because it did. What separates a mistake from
 * a decision is what the holder expected, and that is not a fact about the
 * transaction at all. So this module does not infer it: it reads what the
 * holder pre-committed to, and a policy with no declaration goes to a human
 * rather than being paid or denied.
 *
 * **The complement, and why it matters.** Step 5 rejects anything the agent
 * did *not* authorise, naming the trigger it belongs to. Paired with the
 * exploit adjudicator's `agent_authorized_movement`, that makes the two
 * exhaustive and disjoint over authorised/unauthorised loss — which is what
 * stops this trigger being the dumping ground it became when three different
 * monitoring events all routed here.
 */

/** Bump on any change that alters what this function decides. */
export const AGENT_ERROR_ADJUDICATOR_VERSION = '1.1.0';

export type Outcome = 'confirmed' | 'rejected' | 'indeterminate';

export interface AgentErrorVerdict {
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
 * Highest confidence reachable here.
 *
 * The same ceiling the other two pure adjudicators carry, below
 * `AUTO_PAY_CONFIDENCE` (0.95), and for the same structural reason:
 * off-chain analysis can never release funds on its own. Releasing funds
 * requires the chain's own arithmetic — here, a drop it measured against an
 * envelope the holder signed for. Do not close the gap by raising this.
 */
export { CONFIDENCE_CEILING } from '../confidence-lanes.js';

/**
 * Score a fully collected evidence bundle.
 *
 * Degrades to `indeterminate` on missing inputs rather than guessing, so an
 * older bundle replayed against a newer adjudicator produces "cannot tell"
 * instead of a confident answer built on absent evidence.
 */
export function adjudicateAgentError(bundle: AgentErrorEvidenceBundle): AgentErrorVerdict {
  const { position, loss, authorization, mandate, breach } = bundle;

  if (!position || !authorization) {
    return indeterminate('incomplete_evidence_bundle', {
      hasPosition: position !== undefined,
      hasAuthorization: authorization !== undefined,
      hasLoss: loss !== undefined,
      bundleVersion: bundle.version,
    });
  }

  // Authorization is unanswerable from the indexer payload — no signer flags,
  // no token-account owners. Step 5 turns on it entirely, so confirming
  // without it would be guessing at the fact that separates this trigger from
  // its neighbour.
  if (!bundle.hasRawTx) {
    return indeterminate(
      'no_chain_record',
      {
        note:
          'Only the indexer payload was available. Whether the agent’s own authority moved ' +
          'the money cannot be established from it, and this verdict rests on that.',
        positionSource: position.source,
      },
      120,
    );
  }

  // `undefined` is an outage — the lookup never ran — and retries.
  if (mandate === undefined) {
    return indeterminate(
      'mandate_lookup_unavailable',
      { note: 'No mandate reader was supplied; the declared envelope could not be read.' },
      300,
    );
  }

  // `null` is a policy that predates the mechanism, or a holder who has not
  // declared yet. The absence of a declaration is a gap in our records, not
  // the holder's permission — so this is a reviewer's problem, never a
  // rejection.
  if (mandate === null) {
    return indeterminate(
      'no_mandate_declared',
      {
        note:
          'No operating envelope has been declared for this policy. There is nothing to ' +
          'measure the movement against, and silence is not permission.',
        remedy: 'pnpm mandate:declare --policy <id>',
      },
      1_800,
    );
  }

  // A holder who declared late is not a holder who lied. The delay exists so a
  // fraudulent claim has to pre-commit on chain before the incident; a
  // declaration that missed that bar simply cannot support this claim.
  if (!mandate.maturedBeforeClaim) {
    return indeterminate(
      'mandate_not_matured',
      {
        note:
          'The declaration had not matured when the claim was filed, so it cannot serve as ' +
          'evidence of what the agent was permitted to do beforehand.',
        effectiveAt: mandate.effectiveAt,
        declaredAt: mandate.declaredAt,
      },
      1_800,
    );
  }

  const facts = {
    netLossUsd: loss?.netLossUsd ?? null,
    positionSource: position.source,
    agentWasSigner: authorization.agentWasSigner,
    foreignAuthorities: authorization.foreignAuthorities,
    foreignDestinations: authorization.foreignDestinations,
    selfDestinations: authorization.selfDestinations,
    declaredMaxSingleOutflowRaw: mandate.maxSingleOutflowRaw,
    declaredMinRetainedBalanceRaw: mandate.minRetainedBalanceRaw,
    mandateEffectiveAt: mandate.effectiveAt,
    breachedDimensions: breach?.dimensions.map((d) => d.dimension) ?? [],
    breachExcessRaw: breach?.excessRaw ?? null,
    breachProvable: breach?.provable ?? null,
    breachUnevaluated: breach?.unevaluated.map((u) => u.check) ?? [],
    outflowBaselineStale: bundle.outflowBaseline?.stale ?? null,
    medianOutflowRaw: bundle.outflowBaseline?.medianOutflowRaw ?? null,
    slot: bundle.slot,
    blockTime: bundle.blockTime,
  };

  // The decisive fork, and the complement of `adjudicateExploit`'s
  // `agent_authorized_movement`. A movement the agent did not authorise is not
  // an agent error however costly it was, and routing it here would hand it to
  // a verifier that measures it against a spending envelope — a question that
  // has nothing to do with a drain or a seizure.
  if (!authorization.agentWasSigner || authorization.foreignAuthorities.length > 0) {
    return rejected('not_agent_authorized', {
      ...facts,
      note:
        'The agent did not authorise this movement. That is an exploit or a governance ' +
        'takeover, and both have verifiers that can say something about it.',
      belongsTo: authorization.controlChanges.length > 0 ? 'governance_attack' : 'exploit',
    });
  }

  // A transaction that reverted moved nothing. Its cost is fees, which is not
  // a covered loss — and the invented flat 1 USDC the old verifier approved
  // for exactly this case is the single clearest example of a fabricated
  // number on a payout path.
  if (authorization.failed) {
    return rejected('transaction_reverted_no_loss', {
      ...facts,
      note:
        'Transaction reverted; no funds moved. Fee burn is an operational signal, not a ' +
        'covered event.',
    });
  }

  // Money that came home was never lost, whatever route it took or how large
  // it was. This precedes the loss check because a self-transfer can look like
  // a large net movement on the thin evidence shape.
  if (authorization.allDestinationsSelf) {
    return rejected('self_transfer', {
      ...facts,
      note: 'Every destination resolves to the holder or the agent.',
    });
  }

  if (!loss) {
    return indeterminate(
      'position_not_valued',
      {
        note:
          'The position change could not be priced — an unregistered mint, a silent feed, ' +
          'or sources that disagreed. Refusing to guess at the size of the loss.',
        unpriceableMints: position.unpriceableMints,
      },
      600,
    );
  }

  if (!(loss.netLossUsd > 0)) {
    return rejected('no_net_loss', {
      ...facts,
      note: 'Value received matched or exceeded value given up.',
    });
  }

  if (!breach) {
    return indeterminate('no_breach_report', { ...facts }, 600);
  }

  // The false-positive killer, and the line that replaces the entire
  // program-membership decision tree. The holder's own matured declaration
  // says this movement was permitted; the vault does not insure a decision its
  // owner authorised in advance, whatever program it was routed through.
  if (!breach.breached) {
    return rejected('within_mandate', {
      ...facts,
      note:
        'The movement stayed inside the envelope the holder declared. Losing money inside ' +
        'your own declared risk appetite is not a covered event.',
    });
  }

  // The one abuse the declaration mechanism cannot close by itself, caught
  // here because this is the only place that can see both halves of it.
  //
  // A holder may declare an absurdly narrow envelope — a cap far below what
  // their agent has been paying out all along — so that ordinary operation
  // breaches it, and then send value to a third wallet they also control. The
  // `self_transfer` check above only knows about the holder and the agent, so
  // it does not catch that; the maturity delay does not either, because the
  // declaration is made honestly in advance of a loss the holder intends to
  // cause.
  //
  // What does catch it is the agent's own record. A cap below the *median* of
  // what this agent has actually been paying is not a description of how it
  // operates — more than half its ordinary payments would breach it. That is
  // either a claim generator or a holder deliberately restraining a misbehaving
  // agent, and nothing available here separates those two, so it goes to a
  // human. Escalation, not rejection: the second reading is legitimate and
  // closing the claim would punish it.
  const history = bundle.outflowBaseline;
  if (
    history &&
    !history.stale &&
    history.medianOutflowRaw > 0 &&
    mandate.maxSingleOutflowRaw < history.medianOutflowRaw
  ) {
    return indeterminate(
      'mandate_contradicts_history',
      {
        ...facts,
        declaredCapRaw: mandate.maxSingleOutflowRaw,
        medianOutflowRaw: history.medianOutflowRaw,
        transferCount: history.transferCount,
        note:
          'The declared cap sits below the median payment this agent has been making, so ' +
          'most of its ordinary operation would breach it. Either the envelope does not ' +
          'describe the agent, or the holder is restraining one that misbehaves — and the ' +
          'difference is not visible from here.',
      },
      1_800,
    );
  }

  // What the vault owes is the *overshoot*, not the loss.
  //
  // The holder declared how much their agent was permitted to move; the first
  // slice of any breach is therefore risk they said they were willing to run,
  // and the mandate acts as a deductible they authored themselves. It also
  // gives the chain something arithmetically meaningful to bound the oracle
  // with: a compromised key pointed at an agent that merely spent money
  // extracts nothing, because there is no overshoot to extract.
  //
  // A categorical breach — right size, wrong destination — has no overshoot,
  // so it is bounded by the loss instead and cannot take the proven path at
  // all. `provable` carries that to the settlement planner, which routes it to
  // a reviewer rather than to an instruction that would revert.
  const lossRaw = usdToRaw(loss.netLossUsd);
  const payableRaw = breach.provable ? Math.min(breach.excessRaw, lossRaw) : lossRaw;
  const lossAmount = capToCoverage(payableRaw, bundle.coverageRaw);

  if (lossAmount < MIN_PAYABLE_LOSS_RAW) {
    return rejected('breach_below_dust', {
      ...facts,
      lossAmount,
      floor: MIN_PAYABLE_LOSS_RAW,
      note: 'The overshoot beyond the declared envelope is too small to be worth a claim.',
    });
  }

  // A provable breach settles through `verify_and_payout_agent_error`, which
  // enforces its own floor — ten times this module's dust floor, because on
  // chain the number is a cap on what a compromised oracle key can extract
  // rather than a noise filter. Confirming between the two floors sends a
  // transaction that reverts, and a reverted payout is recorded `failed`, not
  // `review`: a correct claim, correctly bounded, quietly dead. Escalate
  // instead, so a human settles what the instruction cannot.
  if (breach.provable && lossAmount < MIN_PROVABLE_MANDATE_BREACH) {
    return indeterminate(
      'breach_below_provable_floor',
      {
        ...facts,
        lossAmount,
        offChainFloor: MIN_PAYABLE_LOSS_RAW,
        onChainFloor: MIN_PROVABLE_MANDATE_BREACH,
        note:
          'The overshoot is real but smaller than the on-chain instruction will settle. ' +
          'Paying it needs a reviewer rather than the proven path.',
      },
      0,
    );
  }

  return {
    outcome: 'confirmed',
    lossAmount,
    confidence: scoreConfidence(bundle, breach),
    reason: 'mandate_breach',
    details: {
      reason: 'mandate_breach',
      ...facts,
      lossRaw,
      payableRaw,
      boundedBy: breach.provable ? 'declared_overshoot' : 'net_loss',
    },
  };
}

/**
 * Confidence in the verdict, not in the size of the loss.
 *
 * The budget is lopsided on purpose, matching the other three adjudicators. How
 * *much* was moved contributes almost nothing; how well established it is that
 * the movement fell outside a declaration that had matured contributes most. A
 * huge overshoot measured against a mandate half of whose dimensions could not
 * be evaluated should not outrank a modest one where every check ran.
 */
function scoreConfidence(
  bundle: AgentErrorEvidenceBundle,
  breach: NonNullable<AgentErrorEvidenceBundle['breach']>,
): number {
  let confidence = 0.6;

  // A breach the chain will re-derive for itself is worth more than one only
  // this process can see.
  if (breach.provable) confidence += 0.15;

  // Dimensions that agree with each other. Two independent declared bounds
  // crossed by the same movement is a stronger statement than one.
  confidence += Math.min(0.1, (breach.dimensions.length - 1) * 0.05);

  // Each check that could not run is a hole in the picture.
  confidence -= Math.min(0.15, breach.unevaluated.length * 0.03);

  // Corroboration from the agent's own history: a movement far outside what
  // this agent normally does is more likely a mistake than a policy change.
  const baseline = bundle.outflowBaseline;
  if (baseline && !baseline.stale && baseline.p95OutflowRaw > 0) {
    const outflowDim = breach.dimensions.find((d) => d.dimension === 'single_outflow');
    const observed = typeof outflowDim?.observed === 'number' ? outflowDim.observed : 0;
    if (observed >= baseline.p95OutflowRaw * 10) confidence += 0.05;
  } else if (baseline === null || baseline?.stale) {
    // Absence of history is not evidence of anything, so this is a small
    // penalty rather than a disqualification.
    confidence -= 0.03;
  }

  // Uncertainty in the reference prices the loss was measured with.
  const loss = bundle.loss;
  if (loss) {
    const confFraction = loss.lostValueUsd > 0 ? loss.confUsd / loss.lostValueUsd : 0;
    confidence -= Math.min(0.1, confFraction * 2);
    if (loss.gained.some((l) => l.parFallback) || loss.lost.some((l) => l.parFallback)) {
      confidence -= 0.03;
    }
  }

  if (bundle.position && bundle.position.unpriceableMints.length > 0) confidence -= 0.03;
  if (bundle.blockTimeDisagreementSec !== undefined && bundle.blockTimeDisagreementSec > 2) {
    confidence -= 0.05;
  }

  return Math.max(0, Math.min(CONFIDENCE_CEILING, Number(confidence.toFixed(4))));
}

function usdToRaw(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function capToCoverage(lossRaw: number, coverageRaw: number): number {
  if (lossRaw <= 0) return 0;
  return Math.min(Math.floor(lossRaw), coverageRaw);
}

function rejected(reason: string, details: Record<string, unknown>): AgentErrorVerdict {
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
): AgentErrorVerdict {
  return {
    outcome: 'indeterminate',
    lossAmount: 0,
    confidence: 0,
    reason,
    details: { reason, ...details },
    retryAfterSec,
  };
}
