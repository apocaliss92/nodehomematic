/**
 * Protocol constants for talking to a CCU3 / RaspberryMatic, mirroring the
 * authoritative values from aiohomematic's `const.py`.
 */

/** Known CCU interfaces (string values are the on-the-wire interface names). */
export enum Interface {
  BIDCOS_RF = 'BidCos-RF',
  HMIP_RF = 'HmIP-RF',
  BIDCOS_WIRED = 'BidCos-Wired',
  VIRTUAL_DEVICES = 'VirtualDevices',
}

/** TCP ports for each interface, both plain and TLS. */
export interface InterfacePorts {
  readonly nonTls: number;
  readonly tls: number;
}

/** Per-interface port mapping. */
export const INTERFACE_PORTS: Readonly<Record<Interface, InterfacePorts>> = {
  [Interface.BIDCOS_RF]: { nonTls: 2001, tls: 42001 },
  [Interface.HMIP_RF]: { nonTls: 2010, tls: 42010 },
  [Interface.BIDCOS_WIRED]: { nonTls: 2000, tls: 42000 },
  [Interface.VIRTUAL_DEVICES]: { nonTls: 9292, tls: 49292 },
};

/** JSON-RPC ports for the CCU WebUI. */
export const JSON_RPC_PORT = 80;
export const JSON_RPC_PORT_TLS = 443;

/** HTTP path of the CCU JSON-RPC endpoint. */
export const JSON_RPC_PATH = '/api/homematic.cgi';

/** Outbound XML-RPC payloads are encoded as ISO-8859-1 (latin1). */
export const ENCODING_OUT = 'iso-8859-1';

/**
 * Encoding used ONLY to decode the request bodies received by the local
 * callback HTTP server (the CCU POSTs its event/system notifications to us).
 *
 * This is NOT the encoding of XML-RPC RESPONSES we receive from the CCU: those
 * are ISO-8859-1 as declared in their XML prolog and are decoded by the
 * parser's declaration-sniffing (see `decodeInput` in `parse.ts`), NOT by this
 * constant. Do not reuse this value to decode CCU responses.
 */
export const ENCODING_IN = 'utf-8';

/** Default timeouts (milliseconds) for the various RPC operations. */
export const TIMEOUTS = {
  /** Generic RPC call timeout. */
  rpc: 60000,
  /** Ping timeout. */
  ping: 10000,
  /** Connect timeout. */
  connect: 30000,
} as const;

/** Build the interface id used to register a callback proxy: `{centralName}-{interface}`. */
export function interfaceId(centralName: string, iface: Interface): string {
  return `${centralName}-${iface}`;
}

/**
 * Parameter operations bitmask (CCU `OPERATIONS` field). A parameter can be any
 * combination of readable, writable and event-emitting.
 */
export enum Operations {
  NONE = 0,
  READ = 1,
  WRITE = 2,
  EVENT = 4,
}

/** True if the parameter can be read (`OPERATIONS & READ`). */
export function isReadable(op: number): boolean {
  return (op & Operations.READ) !== 0;
}

/** True if the parameter can be written (`OPERATIONS & WRITE`). */
export function isWritable(op: number): boolean {
  return (op & Operations.WRITE) !== 0;
}

/** True if the parameter emits events (`OPERATIONS & EVENT`). */
export function hasEvents(op: number): boolean {
  return (op & Operations.EVENT) !== 0;
}

/** Parameter flags bitmask (CCU `FLAGS` field). */
export enum Flag {
  VISIBLE = 1,
  INTERNAL = 2,
  TRANSFORM = 4,
  SERVICE = 8,
  STICKY = 0x10,
}

/** True if the parameter is visible to the user (`FLAGS & VISIBLE`). */
export function isVisible(flags: number): boolean {
  return (flags & Flag.VISIBLE) !== 0;
}

/** True if the parameter is a service flag (`FLAGS & SERVICE`). */
export function isService(flags: number): boolean {
  return (flags & Flag.SERVICE) !== 0;
}

/** Parameter value type (CCU `TYPE` field). `EMPTY` is the empty-string variant. */
export enum ParameterType {
  ACTION = 'ACTION',
  BOOL = 'BOOL',
  ENUM = 'ENUM',
  FLOAT = 'FLOAT',
  INTEGER = 'INTEGER',
  STRING = 'STRING',
  DUMMY = 'DUMMY',
  EMPTY = '',
}

/** Paramset identifier. Discovery fetches VALUES + MASTER and skips LINK. */
export enum ParamsetKey {
  MASTER = 'MASTER',
  VALUES = 'VALUES',
  LINK = 'LINK',
  SERVICE = 'SERVICE',
  CALCULATED = 'CALCULATED',
  COMBINED = 'COMBINED',
  DUMMY = 'DUMMY',
}

/** Device receive-mode bitmask (CCU `RX_MODE` field). */
export enum RxMode {
  UNDEFINED = 0,
  ALWAYS = 1,
  BURST = 2,
  CONFIG = 4,
  WAKEUP = 8,
  LAZY_CONFIG = 16,
}

/** Firmware update lifecycle states reported by the CCU (`FIRMWARE_UPDATE_STATE`). */
export enum DeviceFirmwareState {
  UNKNOWN = 'UNKNOWN',
  UP_TO_DATE = 'UP_TO_DATE',
  LIVE_UP_TO_DATE = 'LIVE_UP_TO_DATE',
  NEW_FIRMWARE_AVAILABLE = 'NEW_FIRMWARE_AVAILABLE',
  LIVE_NEW_FIRMWARE_AVAILABLE = 'LIVE_NEW_FIRMWARE_AVAILABLE',
  DELIVER_FIRMWARE_IMAGE = 'DELIVER_FIRMWARE_IMAGE',
  LIVE_DELIVER_FIRMWARE_IMAGE = 'LIVE_DELIVER_FIRMWARE_IMAGE',
  READY_FOR_UPDATE = 'READY_FOR_UPDATE',
  DO_UPDATE_PENDING = 'DO_UPDATE_PENDING',
  PERFORMING_UPDATE = 'PERFORMING_UPDATE',
  BACKGROUND_UPDATE_NOT_SUPPORTED = 'BACKGROUND_UPDATE_NOT_SUPPORTED',
}

/** Per-value status reported alongside a value event. */
export enum ParameterStatus {
  NORMAL = 'NORMAL',
  UNKNOWN = 'UNKNOWN',
  OVERFLOW = 'OVERFLOW',
  UNDERFLOW = 'UNDERFLOW',
  ERROR = 'ERROR',
  INVALID = 'INVALID',
  UNUSED = 'UNUSED',
  EXTERNAL = 'EXTERNAL',
}
