import { TriggerType } from '@covantic/shared';

/**
 * What a confidence score is allowed to authorise.
 *
 * Until this module existed, nothing read `confidence` at all. Every verifier
 * computed one and the keeper recorded it next to the payout without ever
 * comparing it to anything, so a verdict the code itself described as 0.6
 * confident released the same funds as one at 0.95. The exploit verifier's
 * default branch — "an outflow through a program we do not recognise" —
 * confirmed at exactly that 0.6 and was paid in full.
 *
 * The lanes below are the missing comparison. The important property is not
 * where the boundaries sit but that the top lane is **unreachable by
 * off-chain analysis alone**: both pure adjudicators cap confidence at 0.92,
 * below {@link AUTO_PAY_CONFIDENCE}, so an automatic payout always requires
 * the chain's own measurement — a guardian-signed price it verified, or a
 * balance drop it measured. That is a structural guarantee rather than a
 * policy someone can quietly relax, because relaxing it means editing a
 * ceiling in a file whose whole purpose is to be audited.
 */

/**
 * Confidence at which a verdict may pay without the chain corroborating it.
 *
 * Deliberately above every adjudicator's ceiling. See above: this is meant to
 * be unreachable today, and the constant exists so the intent is explicit
 * rather than an accident of two numbers that happen not to meet.
 */
export const AUTO_PAY_CONFIDENCE = 0.95;

/** Below this, a confirmed verdict still goes to a human. */
export const REVIEW_CONFIDENCE = 0.75;

export type LaneDecision =
  /** Settle now. */
  | { lane: 'pay'; requiresChainProof: boolean }
  /** Confirmed, but not on evidence strong enough to release funds. */
  | { lane: 'review'; reason: string };

export interface LaneInput {
  triggerType: number;
  confidence: number;
  /** Whether this trigger has an instruction that makes the chain check the
   *  claim before releasing funds, and whether it is switched on. */
  proofAvailable: boolean;
}

/**
 * Decide what a confirmed verdict earns.
 *
 * Only ever called for `confirmed`; `indeterminate` and `rejected` have their
 * own paths and must not be routed through a confidence comparison — "we
 * could not check" is not a low-confidence yes.
 */
export function decideLane(input: LaneInput): LaneDecision {
  if (input.confidence >= AUTO_PAY_CONFIDENCE) {
    return { lane: 'pay', requiresChainProof: false };
  }

  if (input.confidence < REVIEW_CONFIDENCE) {
    return {
      lane: 'review',
      reason: `confidence_below_review_bar:${input.confidence.toFixed(2)}`,
    };
  }

  // The middle lane, and the one that does the real work. Off-chain evidence
  // this good is worth paying on — but only bounded by something the chain
  // checked for itself, so the backend cannot be the sole author of both the
  // finding and the amount.
  if (!input.proofAvailable) {
    return {
      lane: 'review',
      reason: hasProofPath(input.triggerType)
        ? 'proof_path_unavailable'
        : 'no_proof_path_for_trigger',
    };
  }

  return { lane: 'pay', requiresChainProof: true };
}

/** Triggers with an instruction that verifies the claim on chain. */
export function hasProofPath(triggerType: number): boolean {
  return (
    triggerType === TriggerType.Exploit ||
    triggerType === TriggerType.OracleManipulation ||
    triggerType === TriggerType.GovernanceAttack
  );
}
