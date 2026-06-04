/**
 * Value conversion + validation between the CCU wire representation and the
 * library's JS-facing {@link HmValue} domain.
 *
 * The CCU speaks a small set of {@link ParameterType}s. Inbound values arrive as
 * loosely-typed XML-RPC scalars (numbers, strings, booleans); outbound writes
 * must be coerced and validated against the parameter metadata before hitting
 * the wire. This module is pure: it never touches the network.
 */

import type { ParameterSpec } from '../central/graph.js';
import { ParameterType } from '../support/constants.js';
import { ValidationError, UnsupportedError } from '../support/errors.js';

/** The JS-facing value of a data point. */
export type HmValue = boolean | number | string | null;

/** Coerce a loosely-typed scalar to a boolean (CCU sends 1/0, '1'/'0', 'true'/'false'). */
function toBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0' || lower === '') return false;
    return Boolean(raw);
  }
  return Boolean(raw);
}

/**
 * Stringify an untrusted value safely. Objects/arrays are JSON-encoded rather
 * than relying on `Object.prototype.toString` (which would yield
 * `[object Object]`); primitives use their natural string form.
 */
function safeStringify(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    return String(raw);
  }
  if (raw === null || raw === undefined) return String(raw);
  if (typeof raw === 'symbol') return raw.toString();
  try {
    return JSON.stringify(raw) ?? Object.prototype.toString.call(raw);
  } catch {
    return Object.prototype.toString.call(raw);
  }
}

/** Coerce to a finite number, or `null` if the value is empty / not a finite number. */
function toFiniteNumberOrNull(raw: unknown): number | null {
  if (raw === '' || raw === null || raw === undefined) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * Convert a raw CCU value to the JS-facing {@link HmValue}, using `spec` to pick
 * the right coercion. Inbound conversion is lenient: malformed numerics become
 * `null` rather than throwing (the CCU is the trusted source here).
 */
export function convertFromCcu(spec: ParameterSpec, raw: unknown): HmValue {
  switch (spec.type) {
    case ParameterType.FLOAT:
    case ParameterType.INTEGER:
      return toFiniteNumberOrNull(raw);

    case ParameterType.BOOL:
      return toBool(raw);

    case ParameterType.ENUM:
      return enumFromCcu(spec, raw);

    case ParameterType.STRING:
      return safeStringify(raw);

    case ParameterType.ACTION:
      return Boolean(raw);

    default:
      // Unknown / EMPTY / DUMMY: defensively reduce to a primitive.
      if (raw === '' || raw === null || raw === undefined) return null;
      return safeStringify(raw);
  }
}

/** ENUM inbound: CCU sends a numeric index; map to the value-list string when possible. */
function enumFromCcu(spec: ParameterSpec, raw: unknown): HmValue {
  const list = spec.valueList;
  if (list !== undefined) {
    if (typeof raw === 'string') {
      // Already a value-list member?
      if (list.includes(raw)) return raw;
      // Numeric-looking string index.
      const idx = Number(raw);
      if (Number.isInteger(idx) && idx >= 0 && idx < list.length) {
        return list[idx] as string;
      }
    } else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < list.length) {
      return list[raw] as string;
    }
  }
  // No list, or index out of range: expose the numeric index as-is.
  const num = Number(raw);
  return Number.isFinite(num) ? num : String(raw);
}

/** Throw {@link UnsupportedError} if the parameter cannot be written. */
export function validateWritable(spec: ParameterSpec): void {
  if (!spec.writable) {
    throw new UnsupportedError('Parameter is not writable (OPERATIONS lacks WRITE).');
  }
}

/** Options governing outbound conversion. */
export interface ToCcuOptions {
  /** When true, ENUM values are serialised as the integer index (HM-style). */
  readonly enumAsIndex: boolean;
}

/**
 * Convert and validate a JS-facing {@link HmValue} into the CCU wire scalar for
 * `spec`. Throws {@link UnsupportedError} if the parameter is not writable, and
 * {@link ValidationError} on an out-of-range, non-integer, or unknown-enum value.
 */
export function convertToCcu(
  spec: ParameterSpec,
  value: HmValue,
  opts: ToCcuOptions,
): boolean | number | string {
  validateWritable(spec);

  switch (spec.type) {
    case ParameterType.FLOAT:
      return numberToCcu(spec, value, false);

    case ParameterType.INTEGER:
      return numberToCcu(spec, value, true);

    case ParameterType.BOOL:
      return toBool(value);

    case ParameterType.ENUM:
      return enumToCcu(spec, value, opts.enumAsIndex);

    case ParameterType.STRING:
      return String(value);

    case ParameterType.ACTION:
      return true;

    default:
      // Unknown / EMPTY / DUMMY: pass through as a string.
      return String(value);
  }
}

/** Numeric outbound: coerce, optionally require integer, enforce MIN/MAX range. */
function numberToCcu(spec: ParameterSpec, value: HmValue, requireInteger: boolean): number {
  if (value === null) {
    throw new ValidationError('A numeric value is required (got null).');
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new ValidationError(`Value is not a finite number: ${String(value)}`);
  }
  if (requireInteger && !Number.isInteger(num)) {
    throw new ValidationError(`INTEGER parameter requires an integer value: ${String(value)}`);
  }
  if (typeof spec.min === 'number' && num < spec.min) {
    throw new ValidationError(`Value ${num} is below minimum ${spec.min}.`);
  }
  if (typeof spec.max === 'number' && num > spec.max) {
    throw new ValidationError(`Value ${num} is above maximum ${spec.max}.`);
  }
  return num;
}

/** ENUM outbound: resolve to index (HM) or string (HmIP), validating membership. */
function enumToCcu(spec: ParameterSpec, value: HmValue, enumAsIndex: boolean): number | string {
  const list = spec.valueList;

  // Resolve the value to an index within the value list (when one exists).
  let index: number | undefined;
  if (typeof value === 'number') {
    index = value;
  } else if (typeof value === 'string') {
    if (list !== undefined) {
      const found = list.indexOf(value);
      index = found >= 0 ? found : undefined;
      if (found < 0) {
        // Maybe a numeric-looking string index.
        const asNum = Number(value);
        if (Number.isInteger(asNum)) index = asNum;
      }
    }
  }

  if (list !== undefined) {
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= list.length) {
      throw new ValidationError(`ENUM value not in value list: ${String(value)}`);
    }
    return enumAsIndex ? index : (list[index] as string);
  }

  // No value list to validate against: trust the caller.
  if (enumAsIndex) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    throw new ValidationError(`ENUM index required (no value list): ${String(value)}`);
  }
  return String(value);
}
