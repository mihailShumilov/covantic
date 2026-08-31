import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/env.js';
import { planProvenSettlement } from '../src/services/settlement-plan.js';
import { TriggerType } from '@covantic/shared';

/**
 * INV-PROOF-01 — a proof path is reachable on the pass that earns it.
 *
 * The four proven instructions are the protocol's central claim: the chain
 * re-derives the payout from state it reads itself, so the backend cannot be
 * the sole author of both the finding and the amount. None of them could ever
 * run on a real claim.
 *
 * The keeper computes the evidence hash, decides the settlement lane, and
 * *then* persists the hash. `planProvenSettlement` read it back off
 * `claim.verificationData` — the row as loaded before this pass — so on the
 * pass that first produces a verdict the hash is not there, and the plan is
 * `unprovable: no_bundle_hash`. A confirmed verdict has no second pass; it
 * goes to review. Every real claim stopped there.
 *
 * What had been seen paying were *simulated* claims. `syntheticVerification`
 * scores them 1.0, which clears `AUTO_PAY_CONFIDENCE` — the one lane that
 * settles without asking for chain proof at all. So the mechanism looked
 * exercised while the path it exists to take had never been taken.
 */

const config = () =>
  ({
    AGENT_ERROR_PROOF_ENABLED: true,
    EXPLOIT_PROOF_ENABLED: true,
    GOVERNANCE_PROOF_ENABLED: true,
    ORACLE_PROOF_ENABLED: false,
  }) as unknown as AppConfig;

const claim = (verificationData: Record<string, unknown>) =>
  ({
    id: 'c1',
    triggerType: TriggerType.AgentError,
    verificationData,
  }) as unknown as Parameters<typeof planProvenSettlement>[0];

describe('INV-PROOF-01 — this pass’s evidence hash reaches the plan', () => {
  it('routes to the proven instruction on the hash produced this pass', () => {
    // The row carries no hash — exactly the state of a first verdict.
    const plan = planProvenSettlement(claim({ breachProvable: true }), config(), 'abc123');

    expect(plan.kind).toBe('proven_mandate');
    expect(plan.kind === 'proven_mandate' && plan.bundleHash).toBe('abc123');
  });

  it('still fails closed when there is no hash from either source', () => {
    // The guard itself must survive: routing to a proven instruction without a
    // commitment to the off-chain evidence would put an unverifiable claim on
    // chain.
    const plan = planProvenSettlement(claim({ breachProvable: true }), config(), null);

    expect(plan.kind).toBe('unprovable');
    expect(plan.kind === 'unprovable' && plan.reason).toBe('no_bundle_hash');
  });

  it('falls back to the persisted hash for a later pass', () => {
    // `executePayout` re-plans from the stored row, where the hash is real.
    const plan = planProvenSettlement(
      claim({ breachProvable: true, bundleHash: 'stored' }),
      config(),
    );

    expect(plan.kind === 'proven_mandate' && plan.bundleHash).toBe('stored');
  });

  it('keeps the chain-checkability guard, which is a different question', () => {
    // A breach only the backend can see produces no overshoot for the program
    // to measure, and sending it would revert — recorded `failed`, which is
    // closed, rather than `review`.
    const plan = planProvenSettlement(claim({ breachProvable: false }), config(), 'abc123');

    expect(plan.kind === 'unprovable' && plan.reason).toBe('breach_not_chain_checkable');
  });

  it('passes the fresh hash at the keeper’s call site', () => {
    // The plumbing is the fix; a correct function called with the old
    // arguments changes nothing.
    const keeper = readFileSync(
      fileURLToPath(new URL('../src/workers/claim-keeper.ts', import.meta.url)),
      'utf8',
    );

    expect(keeper).toMatch(/planProvenSettlement\(claim, config, evidenceHash\)/);
  });
});
