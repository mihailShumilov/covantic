import { describe, expect, it } from 'vitest';
import {
  ClaimStatus,
  OPEN_CLAIM_STATUSES,
  PARKED_CLAIM_STATUSES,
  TRIGGER_SPECIFICITY,
  TriggerType,
  UNRESOLVABLE_PARK_REASONS,
  isPermanentlyParked,
} from '@covantic/shared';

/**
 * The denial-of-coverage vector, pinned.
 *
 * A policy holds one open claim, and `review`/`indeterminate` count as open.
 * So parking a cheap anomaly on a policy used to make it deaf to every later
 * alert — including the exploit it was insured against — because the unique
 * index rejected the insert and `ingestAlert` swallowed the violation.
 *
 * These assert the rules the fix rests on. The trigger-level ordering has to
 * match the monitor's anomaly ordering, and only genuinely parked claims may
 * lose the slot.
 */
describe('superseding a parked claim', () => {
  it('ranks a takeover above a drain, matching the monitor', () => {
    expect(TRIGGER_SPECIFICITY[TriggerType.GovernanceAttack]).toBeGreaterThan(
      TRIGGER_SPECIFICITY[TriggerType.Exploit],
    );
    expect(TRIGGER_SPECIFICITY[TriggerType.Exploit]).toBeGreaterThan(
      TRIGGER_SPECIFICITY[TriggerType.OracleManipulation],
    );
    expect(TRIGGER_SPECIFICITY[TriggerType.OracleManipulation]).toBeGreaterThan(
      TRIGGER_SPECIFICITY[TriggerType.AgentError],
    );
  });

  it('never lets an absent trigger take the slot', () => {
    for (const t of [
      TriggerType.Exploit,
      TriggerType.OracleManipulation,
      TriggerType.AgentError,
      TriggerType.GovernanceAttack,
    ]) {
      expect(TRIGGER_SPECIFICITY[TriggerType.None]).toBeLessThan(TRIGGER_SPECIFICITY[t]);
    }
  });

  it('treats only the human-parked statuses as superseding candidates', () => {
    // Everything parked must also be open — otherwise it would not be holding
    // the slot in the first place.
    for (const status of PARKED_CLAIM_STATUSES) {
      expect(OPEN_CLAIM_STATUSES).toContain(status);
    }
    // And nothing mid-flight may be superseded: a job or a signed transaction
    // could already be in the air.
    expect(PARKED_CLAIM_STATUSES).not.toContain(ClaimStatus.Verifying);
    expect(PARKED_CLAIM_STATUSES).not.toContain(ClaimStatus.Approved);
    expect(PARKED_CLAIM_STATUSES).not.toContain(ClaimStatus.Paying);
    expect(PARKED_CLAIM_STATUSES).not.toContain(ClaimStatus.Pending);
  });

  it('does not swap on an equally specific repeat', () => {
    // Ties must not supersede: a stream of identical alerts would otherwise
    // reset the claim forever and it would never reach a human.
    const parked = TriggerType.Exploit;
    const incoming = TriggerType.Exploit;
    expect(TRIGGER_SPECIFICITY[incoming] > TRIGGER_SPECIFICITY[parked]).toBe(false);
  });

  it('lets a governance alert take the slot from a parked agent-error claim', () => {
    const parked = TriggerType.AgentError;
    const incoming = TriggerType.GovernanceAttack;
    expect(TRIGGER_SPECIFICITY[incoming] > TRIGGER_SPECIFICITY[parked]).toBe(true);
  });
});

/**
 * The route the specificity ordering did not anticipate.
 *
 * A phished `Approve` followed by a drain is the ordinary shape of a real
 * theft. The approval is a change of control, so a governance claim opens
 * first and parks for want of a baseline the holder never declared. Governance
 * outranks exploit, so without this the drain's claim could never take the
 * slot and the protocol would hold the claim it cannot prove while refusing
 * the one it can.
 */
describe('a park no retry can clear', () => {
  it('recognises the reasons a declaration can never satisfy', () => {
    expect(isPermanentlyParked('no_governance_baseline')).toBe(true);
    expect(isPermanentlyParked('no_mandate_declared')).toBe(true);
    // Fixed comparisons against the incident's block time: waiting cannot
    // make a declaration mature earlier than an event already in the past.
    expect(isPermanentlyParked('governance_baseline_not_matured')).toBe(true);
    expect(isPermanentlyParked('mandate_not_matured')).toBe(true);
  });

  it('leaves outages alone — those really do clear on retry', () => {
    expect(isPermanentlyParked('baseline_lookup_unavailable')).toBe(false);
    expect(isPermanentlyParked('mandate_lookup_unavailable')).toBe(false);
    expect(isPermanentlyParked('position_not_valued')).toBe(false);
    expect(isPermanentlyParked(null)).toBe(false);
    expect(isPermanentlyParked(undefined)).toBe(false);
  });

  it('lets a lower-ranked trigger take a permanently parked slot', () => {
    // The case itself: exploit is ranked *below* governance, and must still
    // win when the governance claim is going nowhere.
    expect(TRIGGER_SPECIFICITY[TriggerType.Exploit]).toBeLessThan(
      TRIGGER_SPECIFICITY[TriggerType.GovernanceAttack],
    );
    expect(isPermanentlyParked('no_governance_baseline')).toBe(true);
  });

  it('keeps every unresolvable reason a park reason and not a status', () => {
    // They are compared against `claims.reviewReason`, which both the review
    // and indeterminate paths write; confusing them with statuses would make
    // the check silently never fire.
    for (const reason of UNRESOLVABLE_PARK_REASONS) {
      expect(typeof reason).toBe('string');
      expect(OPEN_CLAIM_STATUSES).not.toContain(reason as unknown as ClaimStatus);
      expect(PARKED_CLAIM_STATUSES).not.toContain(reason as unknown as ClaimStatus);
    }
  });
});
