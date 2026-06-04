/**
 * Error taxonomy for the transport layer, ported from aiohomematic's exception
 * hierarchy. All errors extend {@link BaseHomematicError}. Mapping helpers turn
 * raw XML-RPC faults, JSON-RPC errors and low-level transport failures into the
 * appropriate typed error.
 */

/** Root of the library error hierarchy. */
export class BaseHomematicError extends Error {
  public constructor(message?: string) {
    super(message);
    // Preserve the concrete class name (and a correct prototype chain under
    // transpilation targets that down-level `extends`).
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Generic client-side / backend error with no more specific classification. */
export class ClientError extends BaseHomematicError {}

/** Operation not supported by the backend or interface. */
export class UnsupportedError extends BaseHomematicError {}

/** Input or argument validation failure (caught before hitting the wire). */
export class ValidationError extends BaseHomematicError {}

/** No usable network connection to the CCU. */
export class NoConnectionError extends BaseHomematicError {}

/** A protected call was rejected because the circuit breaker is OPEN. */
export class CircuitBreakerOpenError extends BaseHomematicError {}

/** No interface clients are available to serve a request. */
export class NoClientsError extends BaseHomematicError {}

/** Authentication/authorization against the CCU failed. */
export class AuthFailureError extends BaseHomematicError {}

/** The backend reported an internal error. */
export class InternalBackendError extends BaseHomematicError {}

/** A newer command superseded this one before it completed. */
export class CommandSupersededError extends BaseHomematicError {}

/** A requested device/paramset description could not be found. */
export class DescriptionNotFoundError extends BaseHomematicError {}

/** A request exceeded its allotted time budget. */
export class TimeoutError extends BaseHomematicError {}

/** Coarse failure classification used by reconnect/health logic. */
export enum FailureReason {
  AUTH = 'AUTH',
  NETWORK = 'NETWORK',
  INTERNAL = 'INTERNAL',
  CIRCUIT_BREAKER = 'CIRCUIT_BREAKER',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Map an XML-RPC `<fault>` to a typed error. Classification is by the
 * fault STRING (aiohomematic does the same), not by the numeric code:
 * - contains "unauthorized" → {@link AuthFailureError}
 * - contains "internal" → {@link InternalBackendError}
 * - otherwise → {@link ClientError}
 */
export function mapXmlRpcFault(faultCode: number, faultString: string): BaseHomematicError {
  const lower = faultString.toLowerCase();
  const detail = `XML-RPC fault ${faultCode}: ${faultString}`;
  if (lower.includes('unauthorized')) return new AuthFailureError(detail);
  if (lower.includes('internal')) return new InternalBackendError(detail);
  return new ClientError(detail);
}

/** Shape of a JSON-RPC error object as returned by the CCU WebUI. */
export interface JsonRpcErrorLike {
  readonly code?: number;
  readonly message?: string;
}

const AUTH_CODES = new Set<number>([401, -32001]);
const INTERNAL_CODES = new Set<number>([-32603, 500]);

/**
 * Map a JSON-RPC error to a typed error. Classification is by message content
 * first, then by numeric code:
 * - message startsWith "access denied" OR code ∈ {401, -32001} → {@link AuthFailureError}
 * - message includes "internal error" OR code ∈ {-32603, 500} → {@link InternalBackendError}
 * - otherwise → {@link ClientError}
 */
export function mapJsonRpcError(error: JsonRpcErrorLike): BaseHomematicError {
  const message = error.message ?? '';
  const lower = message.toLowerCase();
  const code = error.code;
  const detail = `JSON-RPC error${code !== undefined ? ` ${code}` : ''}: ${message}`;

  if (lower.startsWith('access denied') || (code !== undefined && AUTH_CODES.has(code))) {
    return new AuthFailureError(detail);
  }
  if (lower.includes('internal error') || (code !== undefined && INTERNAL_CODES.has(code))) {
    return new InternalBackendError(detail);
  }
  return new ClientError(detail);
}

const NETWORK_ERROR_CODES = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const NETWORK_ERROR_NAMES = new Set<string>(['AbortError', 'TimeoutError', 'ConnectTimeoutError']);

/**
 * Map a low-level transport failure to a typed error. OS/socket-level failures
 * (and aborts/timeouts) become {@link NoConnectionError}; anything else becomes
 * a {@link ClientError}.
 */
export function mapTransportError(err: unknown): BaseHomematicError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
      return new NoConnectionError(err.message);
    }
    if (NETWORK_ERROR_NAMES.has(err.name)) {
      return new NoConnectionError(err.message);
    }
    return new ClientError(err.message);
  }
  return new ClientError(String(err));
}

/** Reduce a thrown error to a coarse {@link FailureReason}. */
export function exceptionToFailureReason(err: unknown): FailureReason {
  if (err instanceof AuthFailureError) return FailureReason.AUTH;
  if (err instanceof NoConnectionError) return FailureReason.NETWORK;
  if (err instanceof InternalBackendError) return FailureReason.INTERNAL;
  if (err instanceof CircuitBreakerOpenError) return FailureReason.CIRCUIT_BREAKER;
  if (err instanceof TimeoutError) return FailureReason.TIMEOUT;
  return FailureReason.UNKNOWN;
}
