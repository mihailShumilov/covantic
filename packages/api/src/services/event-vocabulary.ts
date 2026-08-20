import { MonitoringEventType, TriggerType } from '@covantic/shared';

/**
 * Which on-chain trigger each monitoring event opens a claim for.
 *
 * This map and {@link MonitoringEventType} are one contract, and the type
 * below enforces it: `Record<MonitoringEventType, …>` means adding an event
 * type without deciding what it does here fails the build rather than
 * producing alerts the keeper silently drops.
 *
 * That is not hypothetical. The enum used to declare `'governance_change'`
 * while this map keyed `'governance_attack'`, so a governance detector
 * written against the enum would have raised events nothing ever read — with
 * a debug log as the only trace. Nothing in the type system objected, because
 * the map was keyed by `string`.
 *
 * `undefined` is a decision, not a gap. It means: this event is real and
 * worth recording, but there is nothing for a verifier to verify, so it goes
 * to a human instead of opening a claim.
 */
export const EVENT_TO_TRIGGER: Record<MonitoringEventType, TriggerType | undefined> = {
  [MonitoringEventType.Exploit]: TriggerType.Exploit,
  [MonitoringEventType.OracleDeviation]: TriggerType.OracleManipulation,
  [MonitoringEventType.AgentError]: TriggerType.AgentError,
  [MonitoringEventType.GovernanceAttack]: TriggerType.GovernanceAttack,
  [MonitoringEventType.LargeTransfer]: TriggerType.AgentError,
  [MonitoringEventType.FailedTx]: TriggerType.AgentError,

  // Intentionally unmapped, not missing. The exploit watcher raises this when
  // an agent's balance fell against its last checkpoint with no transaction
  // the screen could attribute it to. There is nothing for a verifier to
  // verify, so it belongs to a human — mapping it to a trigger would file a
  // claim whose evidence is "we noticed the money is gone".
  [MonitoringEventType.BalanceDropUnexplained]: undefined,
};

/**
 * Resolve an event type coming off the alert bus.
 *
 * Takes a `string` rather than a `MonitoringEventType` because that is what
 * arrives over Redis: the bus carries JSON, and a payload from an older
 * process — or a malformed one — must resolve to "unhandled" rather than
 * being asserted into the enum.
 */
export function triggerForEvent(eventType: string): TriggerType | undefined {
  if (!Object.hasOwn(EVENT_TO_TRIGGER, eventType)) return undefined;
  return EVENT_TO_TRIGGER[eventType as MonitoringEventType];
}

/** True when the event type is one the pipeline knows about at all. */
export function isKnownEventType(eventType: string): eventType is MonitoringEventType {
  return Object.hasOwn(EVENT_TO_TRIGGER, eventType);
}
