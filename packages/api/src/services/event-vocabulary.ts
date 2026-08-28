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

  // Intentionally unmapped, not missing — and this one is the change that
  // makes the trigger coherent. `large_transfer` says a movement was big. It
  // says nothing about whether it was permitted, and after this change the
  // covered event *is* "outside the envelope the holder declared", so a signal
  // that cannot reference a declaration cannot describe the event.
  //
  // Leaving it mapped would have re-introduced, by a different route, exactly
  // the blockage `failed_tx` caused below: every ≥1,000-USD movement by an
  // agent with no mandate would open a claim, resolve `no_mandate_declared`
  // → `review`, and then occupy the policy's single open-claim slot
  // indefinitely. The monitor still raises it, records it and alerts on it;
  // it simply no longer files a claim nothing can adjudicate.
  [MonitoringEventType.LargeTransfer]: undefined,

  // Intentionally unmapped, not missing. A reverted transaction moved no
  // funds; what it cost is fees. Until this became `undefined` the chain ran:
  // the fleet lands deliberate failures on chain, the monitor raised
  // `failed_tx` for each one, the keeper inserted a claim row before any
  // verification, the verifier confirmed it at 0.6 on a flat invented 1 USDC,
  // and the confidence lane parked it in `review` — an OPEN status. From that
  // point `claims_open_unique` rejected every further alert for the policy,
  // including a genuine exploit or governance takeover, with an `info` log as
  // the only trace.
  //
  // So one failed transaction blocked all claim origination for that policy
  // until a human cleared the queue. Fee burn is still recorded as a
  // monitoring event and still feeds the risk score; it is simply not a
  // covered loss. If it ever becomes one it will be as a declared window
  // quantity measured against real lamport spend, not as a flat number
  // invented per reverted transaction.
  [MonitoringEventType.FailedTx]: undefined,

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
