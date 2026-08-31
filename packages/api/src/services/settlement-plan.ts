import { TriggerType, type VerificationData } from '@covantic/shared';
import type { AppConfig } from '../config/env.js';
import type { claims } from '../db/schema.js';
import type { ProofInputs } from './verifiers/oracle-manipulation.js';

type ClaimRow = typeof claims.$inferSelect;

/**
 * Which settlement path this claim takes.
 *
 * `proven_price`   — the chain verifies a guardian-signed Pyth price before
 *                    releasing funds (oracle manipulation).
 * `proven_balance` — the chain measures the drop itself, against a checkpoint
 *                    it wrote earlier, and refuses to pay more (exploit).
 * `proven_authority` — the chain compares the holder's own matured
 *                    declaration of who may control the agent against what it
 *                    reads on the account now (governance attack). The only
 *                    path where the chain establishes the covered *event*
 *                    rather than merely bounding its size.
 * `proven_mandate` — the chain measures the drop and checks how far it landed
 *                    outside an operating envelope the holder declared and
 *                    which matured before the claim was filed (agent error).
 * `legacy`         — the pre-proof instruction; the chain trusts the amount.
 * `unprovable`     — proof is required for this trigger but an input is
 *                    missing. Fails closed, to review.
 */
export type SettlementPlan =
  | { kind: 'proven_price'; proof: ProofInputs; triggerBlockTime: number; bundleHash: string }
  | { kind: 'proven_balance'; bundleHash: string }
  | { kind: 'proven_authority'; bundleHash: string }
  | { kind: 'proven_mandate'; bundleHash: string }
  | { kind: 'legacy' }
  | { kind: 'unprovable'; reason: string };

/**
 * @param freshBundleHash the hash `recordEvidence` produced on *this* pass.
 *
 * Required, and the reason is the whole defect this parameter closes. The
 * keeper computes the hash, then decides the lane, then persists the hash — so
 * reading it back off `claim.verificationData` reads the row as it was loaded
 * *before* this pass, where the hash for this verdict does not exist yet.
 * Every proof path therefore planned `no_bundle_hash` on its first pass, and a
 * confirmed verdict has no second pass: it goes to review.
 *
 * The consequence is larger than it looks. All four proven instructions were
 * unreachable on real claims. What had been observed paying were simulated
 * ones, which `syntheticVerification` scores at confidence 1.0 — above
 * `AUTO_PAY_CONFIDENCE`, the one lane that settles without asking for chain
 * proof at all.
 */
export function planProvenSettlement(
  claim: ClaimRow,
  config: AppConfig,
  freshBundleHash?: string | null,
): SettlementPlan {
  const data = (claim.verificationData ?? {}) as VerificationData & {
    proof?: ProofInputs;
    blockTime?: number;
    bundleHash?: string;
    /** Agent error only: whether the breach the verdict rests on is one the
     *  program can re-derive for itself. */
    breachProvable?: boolean;
  };
  // The demo path never touches a real transaction, so there is nothing on
  // chain for either proof instruction to read.
  if (data.simulated === true) return { kind: 'legacy' };

  // This pass's hash first; the persisted one only for a later pass over a
  // claim whose evidence was recorded earlier.
  const hash = freshBundleHash ?? data.bundleHash;

  if (claim.triggerType === TriggerType.OracleManipulation) {
    if (!config.ORACLE_PROOF_ENABLED) return { kind: 'legacy' };
    if (!data.proof?.signedUpdateHex) {
      return { kind: 'unprovable', reason: 'no_signed_price_evidence' };
    }
    if (typeof data.blockTime !== 'number') {
      return { kind: 'unprovable', reason: 'no_trigger_block_time' };
    }
    if (!hash) return { kind: 'unprovable', reason: 'no_bundle_hash' };
    return {
      kind: 'proven_price',
      proof: data.proof,
      triggerBlockTime: data.blockTime,
      bundleHash: hash,
    };
  }

  if (claim.triggerType === TriggerType.Exploit) {
    if (!config.EXPLOIT_PROOF_ENABLED) return { kind: 'legacy' };
    // Nothing else is needed from the backend. The program derives the
    // covered account itself and measures the drop against its own
    // checkpoint, so the only thing to carry across is the commitment to the
    // off-chain evidence — which is precisely the part the chain cannot
    // check and therefore the part that must be on the record.
    if (!hash) return { kind: 'unprovable', reason: 'no_bundle_hash' };
    return { kind: 'proven_balance', bundleHash: hash };
  }

  if (claim.triggerType === TriggerType.GovernanceAttack) {
    if (!config.GOVERNANCE_PROOF_ENABLED) return { kind: 'legacy' };
    // Nothing else is needed from the backend. The program reads the
    // baseline, the authority checkpoint and the covered account itself, and
    // decides whether control left the declared set. The only thing to carry
    // across is the commitment to the off-chain evidence — the part the chain
    // cannot check, and therefore the part that must be on the record.
    if (!hash) return { kind: 'unprovable', reason: 'no_bundle_hash' };
    return { kind: 'proven_authority', bundleHash: hash };
  }

  if (claim.triggerType === TriggerType.AgentError) {
    if (!config.AGENT_ERROR_PROOF_ENABLED) return { kind: 'legacy' };
    if (!hash) return { kind: 'unprovable', reason: 'no_bundle_hash' };
    // The dimension check the other three paths do not need.
    //
    // A mandate has five dimensions and the program can re-derive two of them:
    // it reads the covered account's balance, so it can check the outflow cap
    // and the retention floor. It cannot inspect a *past* transaction, so a
    // breach of the counterparty or program allowlists produces no overshoot
    // for it to measure — and `verify_and_payout_agent_error` refuses to
    // settle one rather than paying on an assertion it cannot check.
    //
    // Routing such a claim to the proven path anyway would send a transaction
    // that reverts with `OutflowWithinMandate`, and the keeper marks a failed
    // payout `failed` rather than `review` — turning a valid claim a human
    // should look at into a dead one. So it fails closed here instead.
    if (data.breachProvable !== true) {
      return { kind: 'unprovable', reason: 'breach_not_chain_checkable' };
    }
    return { kind: 'proven_mandate', bundleHash: hash };
  }

  return { kind: 'legacy' };
}
