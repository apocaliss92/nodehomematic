/**
 * XML-RPC value model and Homematic protocol shapes used by the serializer,
 * parser and clients.
 */

import type { ParamsetKey as ParamsetKeyEnum } from '../../support/constants.js';

/**
 * Any value that can cross the XML-RPC wire. Objects map to `<struct>`, arrays
 * to `<array>`. `Date` maps to `<dateTime.iso8601>` and `Uint8Array`/`Buffer`
 * to `<base64>`.
 */
export type XmlRpcValue =
  | number
  | boolean
  | string
  | null
  | Date
  | Uint8Array
  | XmlRpcValue[]
  | { [key: string]: XmlRpcValue };

/** A parsed `<fault>` response. */
export interface XmlRpcFault {
  readonly faultCode: number;
  readonly faultString: string;
}

/** A parsed `<methodCall>` (used by the callback server). */
export interface XmlRpcMethodCall {
  readonly methodName: string;
  readonly params: XmlRpcValue[];
}

/**
 * Result of parsing an XML-RPC document. Exactly one of the variants applies,
 * discriminated by `kind`.
 */
export type XmlRpcParsed =
  | { readonly kind: 'response'; readonly value: XmlRpcValue }
  | { readonly kind: 'fault'; readonly fault: XmlRpcFault }
  | { readonly kind: 'call'; readonly call: XmlRpcMethodCall };

/**
 * Raw device description as returned by `listDevices` / `getDeviceDescription`.
 * Fields are intentionally permissive at the transport layer; the model layer
 * (later phase) refines them. Optional fields below are the well-known uppercase
 * keys the CCU may return; the index signature keeps the shape permissive for
 * any additional keys. A device has an empty/absent `PARENT`; a channel has
 * `ADDRESS="DEV:idx"` and `PARENT=devAddress`.
 */
export interface DeviceDescription {
  readonly ADDRESS: string;
  readonly TYPE: string;
  /** Names of the paramsets exposed by this address (e.g. `VALUES`, `MASTER`). */
  readonly PARAMSETS?: string[];
  /** Child channel addresses (devices only). */
  readonly CHILDREN?: string[];
  /** Parent device address (channels only); empty/absent on devices. */
  readonly PARENT?: string;
  readonly PARENT_TYPE?: string;
  readonly SUBTYPE?: string;
  readonly INTERFACE?: string;
  readonly INDEX?: number;
  readonly VERSION?: number;
  readonly FLAGS?: number;
  readonly DIRECTION?: number;
  readonly FIRMWARE?: string;
  readonly AVAILABLE_FIRMWARE?: string;
  readonly FIRMWARE_UPDATE_STATE?: string;
  readonly FIRMWARE_UPDATABLE?: boolean;
  readonly RX_MODE?: number;
  readonly AES_ACTIVE?: number;
  readonly ROAMING?: number;
  readonly GROUP?: string;
  readonly TEAM?: string;
  readonly TEAM_CHANNELS?: string[];
  readonly RF_ADDRESS?: number;
  readonly [key: string]: XmlRpcValue | undefined;
}

/** Raw parameter description from `getParamsetDescription`. */
export interface ParameterData {
  readonly TYPE: string;
  readonly OPERATIONS?: number;
  readonly FLAGS?: number;
  readonly DEFAULT?: XmlRpcValue;
  readonly MIN?: XmlRpcValue;
  readonly MAX?: XmlRpcValue;
  readonly UNIT?: string;
  readonly VALUE_LIST?: string[];
  readonly SPECIAL?: XmlRpcValue;
  readonly ID?: string;
  readonly CONTROL?: string;
  readonly TAB_ORDER?: number;
  readonly [key: string]: XmlRpcValue | undefined;
}

/**
 * Paramset keys accepted by the CCU.
 *
 * Single source of truth is the {@link ParamsetKeyEnum} in `support/constants.ts`.
 * This type is the string-literal union of that enum's values so it stays in
 * sync with the canonical enum while still accepting plain string literals
 * (`'VALUES'`) at transport call sites.
 */
export type ParamsetKey = `${ParamsetKeyEnum}`;
