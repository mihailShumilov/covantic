import { describe, expect, it } from 'vitest';
import {
  ClaimStatus,
  OPEN_CLAIM_STATUSES,
  PARKED_CLAIM_STATUSES,
  TRIGGER_SPECIFICITY,
  TriggerType,
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
