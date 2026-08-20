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
 * `legacy`         — the pre-proof instruction; the chain trusts the amount.
 * `unprovable`     — proof is required for this trigger but an input is
 *                    missing. Fails closed, to review.
 */
export type SettlementPlan =
  | { kind: 'proven_price'; proof: ProofInputs; triggerBlockTime: number; bundleHash: string }
  | { kind: 'proven_balance'; bundleHash: string }
  | { kind: 'proven_authority'; bundleHash: string }
  | { kind: 'legacy' }
  | { kind: 'unprovable'; reason: string };

export function planProvenSettlement(claim: ClaimRow, config: AppConfig): SettlementPlan {
  const data = (claim.verificationData ?? {}) as VerificationData & {
    proof?: ProofInputs;
    blockTime?: number;
    bundleHash?: string;
  };
  // The demo path never touches a real transaction, so there is nothing on
  // chain for either proof instruction to read.
  if (data.simulated === true) return { kind: 'legacy' };

  if (claim.triggerType === TriggerType.OracleManipulation) {
    if (!config.ORACLE_PROOF_ENABLED) return { kind: 'legacy' };
    if (!data.proof?.signedUpdateHex) {
      return { kind: 'unprovable', reason: 'no_signed_price_evidence' };
    }
    if (typeof data.blockTime !== 'number') {
      return { kind: 'unprovable', reason: 'no_trigger_block_time' };
    }
    if (!data.bundleHash) return { kind: 'unprovable', reason: 'no_bundle_hash' };
    return {
      kind: 'proven_price',
      proof: data.proof,
      triggerBlockTime: data.blockTime,
      bundleHash: data.bundleHash,
    };
  }

  if (claim.triggerType === TriggerType.Exploit) {
    if (!config.EXPLOIT_PROOF_ENABLED) return { kind: 'legacy' };
    // Nothing else is needed from the backend. The program derives the
    // covered account itself and measures the drop against its own
    // checkpoint, so the only thing to carry across is the commitment to the
    // off-chain evidence — which is precisely the part the chain cannot
    // check and therefore the part that must be on the record.
    if (!data.bundleHash) return { kind: 'unprovable', reason: 'no_bundle_hash' };
    return { kind: 'proven_balance', bundleHash: data.bundleHash };
  }

  if (claim.triggerType === TriggerType.GovernanceAttack) {
    if (!config.GOVERNANCE_PROOF_ENABLED) return { kind: 'legacy' };
    // Nothing else is needed from the backend. The program reads the
    // baseline, the authority checkpoint and the covered account itself, and
    // decides whether control left the declared set. The only thing to carry
    // across is the commitment to the off-chain evidence — the part the chain
    // cannot check, and therefore the part that must be on the record.
    if (!data.bundleHash) return { kind: 'unprovable', reason: 'no_bundle_hash' };
    return { kind: 'proven_authority', bundleHash: data.bundleHash };
  }

  // Agent error has no proof path: neither a signed price, nor a measurable
  // balance drop, nor a declared authority set establishes "the agent did
  // something costly to itself".
  return { kind: 'legacy' };
}
