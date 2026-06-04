/**
 * System-variable domain model + value parsing.
 *
 * The CCU exposes system variables via `SysVar.getAll`, which returns a loose
 * `type` string and a stringified `value`. This module normalises the type and
 * parses the raw value into the library's {@link HmValue} domain. Pure: no I/O.
 */
import type { HmValue } from '../../model/converter.js';

/** The CCU's system-variable value types. */
export enum HubValueType {
  ALARM = 'ALARM',
  FLOAT = 'FLOAT',
  INTEGER = 'INTEGER',
  LIST = 'LIST',
  LOGIC = 'LOGIC',
  NUMBER = 'NUMBER',
  STRING = 'STRING',
}

/** A normalised system variable as exposed by the hub layer. */
export interface SystemVariable {
  readonly id: string;
  readonly name: string;
  readonly type: HubValueType;
  readonly value: HmValue;
  readonly unit?: string;
  readonly isInternal: boolean;
  /** True when the description carried the `HAHM` extended-sysvar marker. */
  readonly writable: boolean;
  readonly valueList?: string[];
  readonly min?: number;
  readonly max?: number;
}

const TRUE_TOKENS: ReadonlySet<string> = new Set(['y', 'yes', 't', 'true', 'on', '1']);

/** Coerce a CCU truthiness string to a boolean (y/yes/t/true/on/1, case-insensitive). */
export function toBool(s: string): boolean {
  return TRUE_TOKENS.has(s.trim().toLowerCase());
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(Object.values(HubValueType));

/**
 * Normalise a CCU type name to a {@link HubValueType}. A bare `NUMBER` is
 * refined to FLOAT when the raw value contains a decimal point, else INTEGER.
 * Unknown type strings fall back to STRING.
 */
export function normalizeType(type: string, rawValue: string): HubValueType {
  const upper = type.trim().toUpperCase();
  if (upper === (HubValueType.NUMBER as string)) {
    return rawValue.includes('.') ? HubValueType.FLOAT : HubValueType.INTEGER;
  }
  return KNOWN_TYPES.has(upper) ? (upper as HubValueType) : HubValueType.STRING;
}

/**
 * Parse a raw CCU value string into the {@link HmValue} domain according to the
 * normalised type: ALARM/LOGIC→bool, FLOAT→number, INTEGER/LIST→int,
 * STRING/NUMBER→raw string.
 */
export function parseSysVarValue(type: HubValueType, raw: string): HmValue {
  switch (type) {
    case HubValueType.ALARM:
    case HubValueType.LOGIC:
      return toBool(raw);
    case HubValueType.FLOAT:
      return Number(raw);
    case HubValueType.INTEGER:
    case HubValueType.LIST:
      return Number.parseInt(raw, 10);
    case HubValueType.STRING:
    case HubValueType.NUMBER:
    default:
      return raw;
  }
}
