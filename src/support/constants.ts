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

/** Inbound callbacks from the CCU are UTF-8. */
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
