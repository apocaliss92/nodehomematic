/**
 * The public event map emitted by the {@link TypedEventEmitter} on the facade.
 *
 * Each key is an event name; its value type is the payload delivered to
 * listeners. `ready` has no payload (`void`) — see {@link TypedEventEmitter}
 * for the ergonomic `emit('ready')`-with-no-argument handling.
 */

import type { HmValue } from '../model/converter.js';

/** Payload of a global `valueChanged` event. */
export interface ValueChangedEvent {
  /** Stable data-point id (dpk encoded). */
  readonly dpId: string;
  /** Device address, e.g. `VCU0000001`. */
  readonly device: string;
  /** Channel address, e.g. `VCU0000001:1`. */
  readonly channel: string;
  /** Parameter name, e.g. `STATE`. */
  readonly parameter: string;
  /** New converted value. */
  readonly value: HmValue;
  /** Previous converted value. */
  readonly prevValue: HmValue;
  /** Epoch-ms timestamp of the change. */
  readonly ts: number;
}

/** Payload of a device add/remove event. */
export interface DeviceEvent {
  readonly device: string;
}

/** Payload of an interface connection-state change. */
export interface ConnectionEvent {
  readonly interfaceId: string;
  readonly state: string;
}

/** The typed map of public events to their payloads. */
export interface HomematicEventMap {
  valueChanged: ValueChangedEvent;
  deviceAdded: DeviceEvent;
  deviceRemoved: DeviceEvent;
  connection: ConnectionEvent;
  ready: void;
  error: Error;
}
