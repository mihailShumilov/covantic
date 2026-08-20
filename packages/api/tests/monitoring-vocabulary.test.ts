import { describe, expect, it } from 'vitest';
import { MonitoringEventType, TriggerType } from '@covantic/shared';
import {
  EVENT_TO_TRIGGER,
  isKnownEventType,
  triggerForEvent,
} from '../src/services/event-vocabulary.js';

/**
 * The gate on a bug class that has no runtime symptom.
 *
 * A detector that raises an event type the keeper does not map produces
 * nothing at all: `triggerForEvent` returns undefined, the keeper logs at
 * debug and returns, and the alert disappears. No error, no failed job, no
 * claim. The only way to notice is to go looking.
 *
 * That is exactly what happened to governance: `MonitoringEventType` declared
 * `'governance_change'` while the keeper mapped `'governance_attack'`. These
 * tests make the two sides of that contract fail loudly instead.
 */

describe('monitoring event vocabulary', () => {
  it('maps every declared event type', () => {
    // The Record<MonitoringEventType, …> type already makes a missing member
    // a compile error. This asserts the runtime object agrees, which a cast
    // or a spread could otherwise break silently.
    for (const eventType of Object.values(MonitoringEventType)) {
      expect(
        Object.hasOwn(EVENT_TO_TRIGGER, eventType),
        `${eventType} is not a key in EVENT_TO_TRIGGER`,
      ).toBe(true);
    }
  });

  it('declares no key that is not a real event type', () => {
    const declared = new Set<string>(Object.values(MonitoringEventType));
    for (const key of Object.keys(EVENT_TO_TRIGGER)) {
      expect(declared.has(key), `${key} is mapped but not declared in MonitoringEventType`).toBe(
        true,
      );
    }
  });

  it('routes governance attacks to the governance trigger', () => {
    // The specific drift this suite exists for.
    expect(triggerForEvent(MonitoringEventType.GovernanceAttack)).toBe(
      TriggerType.GovernanceAttack,
    );
    expect(triggerForEvent('governance_attack')).toBe(TriggerType.GovernanceAttack);
  });

  it('leaves unattributable balance drops unmapped, on purpose', () => {
    // `undefined` here is a decision — there is nothing for a verifier to
    // verify — so it must stay distinguishable from an unknown event type
    // only by intent, never by accident.
    expect(Object.hasOwn(EVENT_TO_TRIGGER, MonitoringEventType.BalanceDropUnexplained)).toBe(true);
    expect(triggerForEvent(MonitoringEventType.BalanceDropUnexplained)).toBeUndefined();
  });

  it('leaves the two size-and-failure signals unmapped, on purpose', () => {
    // Both used to route to AgentError, and both are the same mistake in
    // different clothes: neither says anything about whether the movement was
    // permitted, which is what the trigger now covers.
    //
    // The cost was concrete. `failed_tx` fired on every deliberate fleet
    // failure, opened a claim, confirmed on an invented 1 USDC, landed in
    // `review` — an OPEN status — and from then on `claims_open_unique`
    // silently rejected every further alert for that policy, including a real
    // exploit. `large_transfer` would have done the same thing once the
    // verifier started answering "no mandate declared" instead of guessing.
    expect(triggerForEvent(MonitoringEventType.FailedTx)).toBeUndefined();
    expect(triggerForEvent(MonitoringEventType.LargeTransfer)).toBeUndefined();

    // Still declared, still raised, still alerted on — just not claimable.
    expect(Object.hasOwn(EVENT_TO_TRIGGER, MonitoringEventType.FailedTx)).toBe(true);
    expect(Object.hasOwn(EVENT_TO_TRIGGER, MonitoringEventType.LargeTransfer)).toBe(true);
  });

  it('routes only the mandate-relative signal to the agent-error trigger', () => {
    expect(triggerForEvent(MonitoringEventType.AgentError)).toBe(TriggerType.AgentError);
  });

  it('treats an unrecognised event type as unhandled rather than asserting it', () => {
    expect(isKnownEventType('governance_change')).toBe(false);
    expect(triggerForEvent('governance_change')).toBeUndefined();
    expect(triggerForEvent('constructor')).toBeUndefined();
    expect(triggerForEvent('__proto__')).toBeUndefined();
  });
});
