import {
  adjudicate,
  bundleHash,
  decideLane,
  type EvidenceBundle,
  type ProofInputs,
} from './baseline.js';
import {
  POLICY_STATE_ACTIVE,
  type PolicySnapshot,
  type PredicateInputs,
  type PredicateResult,
} from './types.js';

/** Program constants that `verify_and_payout_v2` enforces. */
export const MAX_PRICE_EVIDENCE_SKEW_SEC = 5;
export const MIN_PROVABLE_DEVIATION_BPS = 50n;
const PRICE_SCALE = 100_000_000n;
const USDC_SCALE = 1_000_000n;
const TRIGGER_ORACLE_MANIPULATION = 2;

export interface EvaluateInput {
  bundle: EvidenceBundle;
  policy: PolicySnapshot;
  nowSec: number;
  waitingWindowSec: number;
}

function noPay(
  input: EvaluateInput,
  reason: string,
  retryable: boolean,
  details: Record<string, unknown> = {},
): PredicateResult {
  return {
    verdict: 'NO_PAY',
    reason,
    policy: input.policy.address,
    trigger_tx: input.bundle.txSignature,
    evidence_hash: bundleHash(input.bundle as unknown as Record<string, unknown>),
    retryable,
    details,
  };
}

/** The largest payout the program can verify for these inputs, in USDC base units. */
export function maxProvableLoss(proof: ProofInputs): bigint {
  const delta = BigInt(Math.abs(proof.executedPriceScaled - proof.observedReferencePriceScaled));
  const quantity = BigInt(proof.subjectQuantity);
  const scale = PRICE_SCALE * 10n ** BigInt(proof.subjectDecimals);
  return (delta * quantity * USDC_SCALE) / scale;
}

function deviationBps(proof: ProofInputs): bigint {
  const delta = BigInt(Math.abs(proof.executedPriceScaled - proof.observedReferencePriceScaled));
  return (delta * 10_000n) / BigInt(proof.observedReferencePriceScaled);
}

function policyGate(input: EvaluateInput): string | null {
  const { bundle, policy, nowSec, waitingWindowSec } = input;
  if (policy.state !== POLICY_STATE_ACTIVE) return 'policy_not_active';
  if (nowSec >= policy.expiryTime) return 'policy_expired';
  if (bundle.agentAddress !== policy.agent) return 'trigger_tx_not_from_covered_agent';
  if (bundle.blockTime === null) return null;
  if (bundle.blockTime < policy.startTime + waitingWindowSec) return 'loss_before_waiting_window';
  if (bundle.blockTime > policy.expiryTime) return 'loss_after_policy_expiry';
  return null;
}

/** Why the program would refuse these inputs, or null when it would accept them. */
function proofGate(proof: ProofInputs, input: EvaluateInput): string | null {
  const terms = input.policy.terms;
  if (!terms) return 'policy_has_no_price_terms';
  if (proof.feedIdHex !== terms.feedIdHex) return 'feed_differs_from_policy_terms';
  if (proof.subjectDecimals !== terms.subjectDecimals) return 'decimals_differ_from_policy_terms';
  if (BigInt(proof.subjectQuantity) > terms.maxSubjectQuantity) {
    return 'quantity_above_policy_terms';
  }
  if (input.bundle.blockTime === null) return 'no_block_time';
  if (Math.abs(proof.pricePublishTime - input.bundle.blockTime) > MAX_PRICE_EVIDENCE_SKEW_SEC) {
    return 'signed_price_too_far_from_block_time';
  }
  if (deviationBps(proof) < MIN_PROVABLE_DEVIATION_BPS) return 'deviation_below_chain_minimum';
  return null;
}

/**
 * Decides whether a policy pays for a transaction. Pure: the same evidence
 * gives the same verdict, so anyone holding a bundle can recompute it.
 *
 * It keeps the baseline's three-valued outcome. `indeterminate` and a confirmed
 * verdict with no chain proof are NO_PAY with `retryable: true`, because they
 * mean the evidence is not there yet, not that the claim is false.
 */
export function evaluate(input: EvaluateInput): PredicateResult {
  const gate = policyGate(input);
  if (gate) return noPay(input, gate, false);

  const verdict = adjudicate(input.bundle);
  if (verdict.outcome === 'rejected') return noPay(input, verdict.reason, false, verdict.details);
  if (verdict.outcome === 'indeterminate') {
    return noPay(input, verdict.reason, true, verdict.details);
  }

  const proof = (verdict.details.proof ?? null) as ProofInputs | null;
  const lane = decideLane({
    triggerType: TRIGGER_ORACLE_MANIPULATION,
    confidence: verdict.confidence,
    proofAvailable: proof !== null,
  });
  if (lane.lane === 'review') {
    return noPay(input, lane.reason, true, { confidence: verdict.confidence });
  }
  if (proof === null) return noPay(input, 'proof_path_unavailable', true);

  const refused = proofGate(proof, input);
  if (refused) return noPay(input, refused, false, { proof: { ...proof, signedUpdateHex: '' } });

  const payoutAmount = [
    BigInt(verdict.lossAmount),
    BigInt(input.policy.coverageRaw),
    maxProvableLoss(proof),
  ].reduce((smallest, value) => (value < smallest ? value : smallest));
  if (payoutAmount <= 0n) return noPay(input, 'zero_payout', false);

  const inputs: PredicateInputs = {
    payoutAmount,
    triggerBlockTime: input.bundle.blockTime as number,
    executedPriceScaled: proof.executedPriceScaled,
    subjectQuantity: BigInt(proof.subjectQuantity),
    subjectDecimals: proof.subjectDecimals,
    feedIdHex: proof.feedIdHex,
    signedUpdateHex: proof.signedUpdateHex,
  };
  return {
    verdict: 'PAY',
    reason: verdict.reason,
    policy: input.policy.address,
    trigger_tx: input.bundle.txSignature,
    evidence_hash: bundleHash(input.bundle as unknown as Record<string, unknown>),
    inputs,
  };
}
