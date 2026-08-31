import { describe, expect, it } from 'vitest';
import {
  UNRESOLVABLE_PARK_REASONS,
  TRANSIENT_PARK_REASONS,
  isPermanentlyParked,
  isTransientlyParked,
} from '@covantic/shared';

/**
 * INV-PARK-01 — an outage must not deafen a policy for good.
 *
 * A policy holds one open claim, and `review` is an open status. The tie rule
 * in the keeper refuses an equally specific repeat because, for every reason
 * on `UNRESOLVABLE_PARK_REASONS` *except one*, a repeat says nothing new: no
 * mandate declared, a baseline not matured — those are standing facts about
 * the policy, and a stream of identical alerts would otherwise reset the claim
 * forever.
 *
 * `trigger_tx_not_found` was added to that list without the rationale holding.
 * It describes the *transaction*, not the policy, and it is usually
 * infrastructure: an indexer that lagged, an endpoint that would not answer.
 * When a vendor's quota ran out, every claim parked here — and because a
 * same-trigger alert could not take the slot, none could be replaced after the
 * infrastructure recovered. One outage, and the policy stops being able to
 * claim on that trigger for its whole life.
 */

describe('INV-PARK-01 — a transient dead end is not a standing fact', () => {
  it('classifies the transaction-level reason apart from the policy-level ones', () => {
    expect(isTransientlyParked('trigger_tx_not_found')).toBe(true);

    for (const reason of ['no_mandate_declared', 'mandate_not_matured', 'no_governance_baseline']) {
      expect(isTransientlyParked(reason), reason).toBe(false);
    }
  });

  it('keeps every transient reason on the unresolvable list too', () => {
    // The narrower predicate grants *additional* purchase on the slot; it must
    // not accidentally remove the purchase the broader one already gave, or a
    // lower-specificity claim that could actually be adjudicated would lose
    // its route in.
    for (const reason of TRANSIENT_PARK_REASONS) {
      expect(UNRESOLVABLE_PARK_REASONS).toContain(reason);
      expect(isPermanentlyParked(reason), reason).toBe(true);
    }
  });

  it('says no to an absent reason rather than throwing', () => {
    expect(isTransientlyParked(null)).toBe(false);
    expect(isTransientlyParked(undefined)).toBe(false);
  });

  it('stays narrow — a growing list would re-open the churn the tie rule closes', () => {
    // If this needs updating, the question to answer first is whether the new
    // reason is about the transaction or about the policy. Only the former
    // belongs here.
    expect(TRANSIENT_PARK_REASONS).toEqual(['trigger_tx_not_found']);
  });
});
