/**
 * Retry wrapper for write commands (setValue/putParamset). Classifies errors as
 * retryable or terminal, applies exponential backoff with jitter, and honours
 * the protocol-specific delays for INSUFFICIENT_DUTYCYCLE (-8) and
 * TRANSMISSION_PENDING (-10) faults.
 */

import {
  AuthFailureError,
  CircuitBreakerOpenError,
  CommandSupersededError,
  UnsupportedError,
  ValidationError,
  TimeoutError,
  NoConnectionError,
  InternalBackendError,
} from '../../support/errors.js';
import { XmlRpcFaultCode, isRetryableFaultCode } from '../xmlrpc/fault-codes.js';

/** Options for {@link withRetry}; every field has a protocol-default. */
export interface RetryOptions {
  /** Maximum attempts (including the first). `<= 0` disables retries. */
  readonly maxAttempts?: number;
  /** Base backoff delay in ms. */
  readonly baseDelayMs?: number;
  /** Exponential growth factor per attempt. */
  readonly backoffFactor?: number;
  /** Upper bound for the computed backoff delay in ms. */
  readonly maxDelayMs?: number;
  /** Jitter fraction (±), e.g. 0.2 = ±20%. */
  readonly jitter?: number;
  /** Delay for fault -8 (INSUFFICIENT_DUTYCYCLE). */
  readonly dutyCycleDelayMs?: number;
  /** Delay for fault -10 (TRANSMISSION_PENDING). */
  readonly transmissionPendingDelayMs?: number;
  /** Override the retryable classification. */
  readonly isRetryable?: (err: unknown) => boolean;
  /** Override fault-code extraction. */
  readonly getFaultCode?: (err: unknown) => number | undefined;
  /** Injectable delay (defaults to a setTimeout-based promise). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for jitter (defaults to `Math.random`). */
  readonly random?: () => number;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 2000,
  backoffFactor: 2,
  maxDelayMs: 30000,
  jitter: 0.2,
  dutyCycleDelayMs: 40000,
  transmissionPendingDelayMs: 5000,
} as const;

/** Error types that are NEVER retried. */
const NON_RETRYABLE_TYPES = [
  AuthFailureError,
  CircuitBreakerOpenError,
  CommandSupersededError,
  UnsupportedError,
  ValidationError,
] as const;

/** Error types that ARE retried (independent of any fault code). */
const RETRYABLE_TYPES = [TimeoutError, NoConnectionError, InternalBackendError] as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extract a numeric `faultCode` from an error, walking the `cause` chain.
 * Returns `undefined` when no numeric fault code is present.
 */
export function defaultGetFaultCode(err: unknown): number | undefined {
  let current: unknown = err;
  // Bound the walk to avoid pathological cyclic cause chains.
  for (let depth = 0; depth < 16 && current != null; depth += 1) {
    if (typeof current === 'object') {
      const code = (current as { faultCode?: unknown }).faultCode;
      if (typeof code === 'number') return code;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

/** Default retryable classification per the protocol facts. */
function defaultIsRetryable(
  err: unknown,
  getFaultCode: (e: unknown) => number | undefined,
): boolean {
  if (NON_RETRYABLE_TYPES.some((Ctor) => err instanceof Ctor)) return false;
  if (RETRYABLE_TYPES.some((Ctor) => err instanceof Ctor)) return true;
  const code = getFaultCode(err);
  return code !== undefined && isRetryableFaultCode(code);
}

/** Run `fn`, retrying retryable failures with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const backoffFactor = opts.backoffFactor ?? DEFAULTS.backoffFactor;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitter = opts.jitter ?? DEFAULTS.jitter;
  const dutyCycleDelayMs = opts.dutyCycleDelayMs ?? DEFAULTS.dutyCycleDelayMs;
  const transmissionPendingDelayMs =
    opts.transmissionPendingDelayMs ?? DEFAULTS.transmissionPendingDelayMs;
  const getFaultCode = opts.getFaultCode ?? defaultGetFaultCode;
  const isRetryable =
    opts.isRetryable ?? ((err: unknown): boolean => defaultIsRetryable(err, getFaultCode));
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  // `<= 0` means "no retries": invoke exactly once and let it throw.
  const effectiveMaxAttempts = maxAttempts <= 0 ? 1 : maxAttempts;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const lastAttempt = attempt >= effectiveMaxAttempts;
      if (lastAttempt || !isRetryable(err)) {
        throw err;
      }
      const delay = computeDelay({
        attempt,
        faultCode: getFaultCode(err),
        baseDelayMs,
        backoffFactor,
        maxDelayMs,
        jitter,
        dutyCycleDelayMs,
        transmissionPendingDelayMs,
        random,
      });
      await sleep(delay);
    }
  }
}

interface DelayParams {
  readonly attempt: number;
  readonly faultCode: number | undefined;
  readonly baseDelayMs: number;
  readonly backoffFactor: number;
  readonly maxDelayMs: number;
  readonly jitter: number;
  readonly dutyCycleDelayMs: number;
  readonly transmissionPendingDelayMs: number;
  readonly random: () => number;
}

function computeDelay(p: DelayParams): number {
  if (p.faultCode === XmlRpcFaultCode.INSUFFICIENT_DUTYCYCLE) return p.dutyCycleDelayMs;
  if (p.faultCode === XmlRpcFaultCode.TRANSMISSION_PENDING) return p.transmissionPendingDelayMs;

  const exponential = p.baseDelayMs * Math.pow(p.backoffFactor, p.attempt - 1);
  const capped = Math.min(exponential, p.maxDelayMs);
  if (p.jitter <= 0) return capped;
  // Multiplier in [1 - jitter, 1 + jitter].
  const multiplier = 1 - p.jitter + 2 * p.jitter * p.random();
  return capped * multiplier;
}
