/**
 * Typed central events. {@link CentralEvent} is a discriminated union keyed on
 * the `type` field; the {@link EventBus} dispatches by that discriminant. Each
 * event has a "natural routing key" (see {@link eventKey}) used by key-specific
 * subscribers.
 */

import { dpkToUniqueId, type DataPointKey } from '../support/dpk.js';

/** A value was received for a data point. */
export interface ValueReceivedEvent {
  readonly type: 'valueReceived';
  readonly dpk: DataPointKey;
  readonly value: unknown;
  /** Monotonic/epoch millis when the value was received. */
  readonly receivedAt: number;
}

/** A device was added to the registry. */
export interface DeviceAddedEvent {
  readonly type: 'deviceAdded';
  readonly address: string;
}

/** A device was removed from the registry. */
export interface DeviceRemovedEvent {
  readonly type: 'deviceRemoved';
  readonly address: string;
}

/** A batch of devices was created (e.g. after `newDevices`). */
export interface DevicesCreatedEvent {
  readonly type: 'devicesCreated';
  readonly addresses: string[];
}

/** An interface connection state transition. */
export interface ConnectionStateChangedEvent {
  readonly type: 'connectionStateChanged';
  readonly interfaceId: string;
  readonly state: string;
  readonly reason?: string;
}

/** A recovery stage transition for an interface. */
export interface RecoveryStageChangedEvent {
  readonly type: 'recoveryStageChanged';
  readonly interfaceId: string;
  readonly stage: string;
}

/** The backend reported a system-level error for an interface. */
export interface SystemErrorEvent {
  readonly type: 'systemError';
  readonly interfaceId: string;
  readonly code: number;
  readonly message: string;
}

/** The central finished its initial startup. */
export interface ReadyEvent {
  readonly type: 'ready';
}

/** Discriminated union of all central events. */
export type CentralEvent =
  | ValueReceivedEvent
  | DeviceAddedEvent
  | DeviceRemovedEvent
  | DevicesCreatedEvent
  | ConnectionStateChangedEvent
  | RecoveryStageChangedEvent
  | SystemErrorEvent
  | ReadyEvent;

/** All valid event type discriminants. */
export type CentralEventType = CentralEvent['type'];

/**
 * The natural routing key for an event, used by key-specific subscribers:
 * - `valueReceived` → the dpk unique id
 * - `deviceAdded` / `deviceRemoved` → the device address
 * - `connectionStateChanged` / `recoveryStageChanged` / `systemError` → interfaceId
 * - `devicesCreated` / `ready` → `undefined` (no natural key)
 */
export function eventKey(event: CentralEvent): string | undefined {
  switch (event.type) {
    case 'valueReceived':
      return dpkToUniqueId(event.dpk);
    case 'deviceAdded':
    case 'deviceRemoved':
      return event.address;
    case 'connectionStateChanged':
    case 'recoveryStageChanged':
    case 'systemError':
      return event.interfaceId;
    case 'devicesCreated':
    case 'ready':
      return undefined;
  }
}
