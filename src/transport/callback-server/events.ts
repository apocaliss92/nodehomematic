/**
 * Normalized callback events emitted by the {@link CallbackServer} when the CCU
 * POSTs a notification (`event`, `newDevices`, …) to our local XML-RPC server.
 *
 * These are RAW transport-level events: no domain interpretation, just a typed,
 * positional-argument-decoded shape. The discriminant is `type`. The model /
 * central layer (later phase) consumes and refines them.
 */

import type { XmlRpcValue } from '../xmlrpc/types.js';

/** A single device/channel value update. */
export interface RawEventEvent {
  readonly type: 'event';
  readonly interfaceId: string;
  readonly channelAddress: string;
  readonly parameter: string;
  readonly value: XmlRpcValue;
}

/** One or more devices were added. `descriptions` are raw device-description structs. */
export interface RawNewDevicesEvent {
  readonly type: 'newDevices';
  readonly interfaceId: string;
  readonly descriptions: ReadonlyArray<Record<string, unknown>>;
}

/** One or more devices were deleted. */
export interface RawDeleteDevicesEvent {
  readonly type: 'deleteDevices';
  readonly interfaceId: string;
  readonly addresses: readonly string[];
}

/** A device changed and should be re-read. `hint` 0 = FIRMWARE, 1 = LINKS. */
export interface RawUpdateDeviceEvent {
  readonly type: 'updateDevice';
  readonly interfaceId: string;
  readonly address: string;
  readonly hint: number;
}

/** A device address was replaced by a new one. */
export interface RawReplaceDeviceEvent {
  readonly type: 'replaceDevice';
  readonly interfaceId: string;
  readonly oldAddress: string;
  readonly newAddress: string;
}

/** Previously deleted devices were re-added. */
export interface RawReaddedDeviceEvent {
  readonly type: 'readdedDevice';
  readonly interfaceId: string;
  readonly addresses: readonly string[];
}

/** The backend reported an error for the interface. */
export interface RawErrorEvent {
  readonly type: 'error';
  readonly interfaceId: string;
  readonly code: number;
  readonly message: string;
}

/** Discriminated union of all raw callback events, keyed by `type`. */
export type RawCallbackEvent =
  | RawEventEvent
  | RawNewDevicesEvent
  | RawDeleteDevicesEvent
  | RawUpdateDeviceEvent
  | RawReplaceDeviceEvent
  | RawReaddedDeviceEvent
  | RawErrorEvent;
