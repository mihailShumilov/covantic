import { describe, expect, it } from 'vitest';
import { TriggerType } from '@covantic/shared';
import { planProvenSettlement } from '../src/services/settlement-plan.js';
import type { AppConfig } from '../src/config/env.js';

/**
 * INV-AUTH-05 — one writer of `bundleHash`, all four triggers.
 *
 * `recordEvidence` is the only function that derives the evidence commitment,
 * and `planProvenSettlement` refuses to route to any proven instruction
 * without it. Before that was centralised only the price verifier folded the
 * hash into its own `details`, so switching on `EXPLOIT_PROOF_ENABLED`,
 * `GOVERNANCE_PROOF_ENABLED` or `AGENT_ERROR_PROOF_ENABLED` would have planned
 * `unprovable: no_bundle_hash` for *every* claim on those triggers — the
 * proven path unreachable, failing closed and therefore silently.
 *
 * `exploit-settlement.test.ts` pins this for the exploit and governance
 * triggers. The agent-error one had no test: both of its planner assertions
 * live in `agent-error-corpus.test.ts` and both hand the planner a bundle hash
 * unconditionally, so a regression that stopped the hash reaching the claim
 * row would not show up anywhere. This covers all four uniformly, and pins the
 * *reason* rather than only the kind, because "unprovable" is the same word
 * for a missing commitment and for a breach the chain cannot measure — and
 * those need different fixes.
 */

type Claim = Parameters<typeof planProvenSettlement>[0];

const ALL_FLAGS = {
  ORACLE_PROOF_ENABLED: true,
  EXPLOIT_PROOF_ENABLED: true,
  GOVERNANCE_PROOF_ENABLED: true,
  AGENT_ERROR_PROOF_ENABLED: true,
} as AppConfig;

/** Everything a proven plan needs *except* the commitment. */
const READY_WITHOUT_HASH: Record<number, Record<string, unknown>> = {
  [TriggerType.OracleManipulation]: {
    blockTime: 1_780_000_000,
    proof: { signedUpdateHex: 'deadbeef' },
  },
  [TriggerType.Exploit]: {},
  [TriggerType.GovernanceAttack]: {},
  [TriggerType.AgentError]: { breachProvable: true },
};

const TRIGGERS = [
  ['oracle manipulation', TriggerType.OracleManipulation, 'proven_price'],
  ['exploit', TriggerType.Exploit, 'proven_balance'],
  ['governance attack', TriggerType.GovernanceAttack, 'proven_authority'],
  ['agent error', TriggerType.AgentError, 'proven_mandate'],
] as const;

function claim(triggerType: number, verificationData: Record<string, unknown>): Claim {
  return { triggerType, verificationData } as unknown as Claim;
}

describe('INV-AUTH-05 — no proven settlement without an evidence commitment', () => {
  for (const [label, trigger, provenKind] of TRIGGERS) {
    it(`fails ${label} closed as no_bundle_hash, and never back to legacy`, () => {
      // Back to `legacy` would be the dangerous answer: the legacy instruction
      // trusts the oracle's number outright, so anyone able to stop a proof
      // being built would simply get the unverified path back.
      expect(planProvenSettlement(claim(trigger, READY_WITHOUT_HASH[trigger]!), ALL_FLAGS)).toEqual({
        kind: 'unprovable',
        reason: 'no_bundle_hash',
      });
    });

    it(`routes ${label} to ${provenKind} once the commitment is present`, () => {
      // The other half: the fixture above really is one field short of a
      // proven plan, so the failure above is attributable to the hash and to
      // nothing else.
      const plan = planProvenSettlement(
        claim(trigger, { ...READY_WITHOUT_HASH[trigger]!, bundleHash: 'ab'.repeat(32) }),
        ALL_FLAGS,
      );

      expect(plan).toMatchObject({ kind: provenKind, bundleHash: 'ab'.repeat(32) });
    });
  }

  it('checks the commitment before the agent-error dimension check', () => {
    // Order matters for the operator, not for safety: both fail closed, but a
    // claim reported as `breach_not_chain_checkable` sends someone to look at
    // the mandate, while `no_bundle_hash` is a pipeline bug.
    expect(
      planProvenSettlement(claim(TriggerType.AgentError, { breachProvable: false }), ALL_FLAGS),
    ).toEqual({ kind: 'unprovable', reason: 'no_bundle_hash' });
  });
});
