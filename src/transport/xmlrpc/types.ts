/**
 * XML-RPC value model and Homematic protocol shapes used by the serializer,
 * parser and clients.
 */

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
 * (later phase) refines them.
 */
export interface DeviceDescription {
  readonly ADDRESS: string;
  readonly TYPE: string;
  readonly [key: string]: XmlRpcValue;
}

/** Raw parameter description from `getParamsetDescription`. */
export interface ParameterData {
  readonly TYPE: string;
  readonly OPERATIONS?: number;
  readonly FLAGS?: number;
  readonly [key: string]: XmlRpcValue | undefined;
}

/** Paramset keys accepted by the CCU. */
export type ParamsetKey = 'VALUES' | 'MASTER' | 'LINK';
