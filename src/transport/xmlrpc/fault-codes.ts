/**
 * XML-RPC fault codes used by the Homematic CCU, mirroring aiohomematic's
 * `HmFaultCode` IntEnum, plus the set of codes considered retryable.
 */

export enum XmlRpcFaultCode {
  GENERIC = -1,
  UNKNOWN_DEVICE = -2,
  UNKNOWN_PARAMSET = -3,
  ADDRESS_EXPECTED = -4,
  UNKNOWN_PARAMETER = -5,
  OP_NOT_SUPPORTED = -6,
  UPDATE_NOT_POSSIBLE = -7,
  INSUFFICIENT_DUTYCYCLE = -8,
  DEVICE_OUT_OF_RANGE = -9,
  TRANSMISSION_PENDING = -10,
}

/** Fault codes for which a retry may succeed. */
export const RETRYABLE_FAULT_CODES: ReadonlySet<number> = new Set<number>([
  XmlRpcFaultCode.GENERIC,
  XmlRpcFaultCode.INSUFFICIENT_DUTYCYCLE,
  XmlRpcFaultCode.DEVICE_OUT_OF_RANGE,
  XmlRpcFaultCode.TRANSMISSION_PENDING,
]);

/** True if the given fault code is retryable. */
export function isRetryableFaultCode(code: number): boolean {
  return RETRYABLE_FAULT_CODES.has(code);
}
