/**
 * DataPointKey (dpk) — the identity of a single value point on the CCU.
 *
 * A dpk uniquely addresses one parameter inside one paramset of one channel on
 * one interface. It is the routing key used to dispatch `event(...)` callbacks
 * to the right data point and to index the value cache.
 */

import { ValidationError } from './errors.js';

/** Identity of a single value point. */
export interface DataPointKey {
  /** Interface id, e.g. `MyCCU-HmIP-RF`. */
  readonly interfaceId: string;
  /** Channel address, e.g. `VCU0000001:1` (note: may itself contain a colon). */
  readonly channelAddress: string;
  /** Paramset key, e.g. `VALUES` / `MASTER`. */
  readonly paramsetKey: string;
  /** Parameter name, e.g. `STATE`. */
  readonly parameter: string;
}

/** Construct a {@link DataPointKey}. */
export function makeDpk(
  interfaceId: string,
  channelAddress: string,
  paramsetKey: string,
  parameter: string,
): DataPointKey {
  return { interfaceId, channelAddress, paramsetKey, parameter };
}

const SEPARATOR = ':';

/**
 * Derive the stable, lowercased `unique_id` string from a dpk.
 *
 * Encoding scheme: positional join with `:` —
 * `interfaceId:channelAddress:paramsetKey:parameter` (lowercased).
 *
 * `channelAddress` itself may contain a single colon (e.g. `VCU0000001:1`). The
 * round-trip is kept exact NOT by escaping but by relying on fixed anchors:
 * the FIRST segment is always `interfaceId`, the LAST is always `parameter` and
 * the SECOND-TO-LAST is always `paramsetKey`. Everything between the first and
 * those two trailing anchors is the `channelAddress` (re-joined with `:`).
 * Because `interfaceId`, `paramsetKey` and `parameter` never contain a colon on
 * the CCU, this positional scheme is unambiguous and reversible.
 */
export function dpkToUniqueId(dpk: DataPointKey): string {
  return [dpk.interfaceId, dpk.channelAddress, dpk.paramsetKey, dpk.parameter]
    .join(SEPARATOR)
    .toLowerCase();
}

/**
 * Parse a `unique_id` back into a {@link DataPointKey}. Tolerant of a
 * `channelAddress` that contains colons (see {@link dpkToUniqueId} for the
 * scheme). Throws {@link ValidationError} if fewer than 4 segments are present.
 */
export function uniqueIdToDpk(uniqueId: string): DataPointKey {
  const parts = uniqueId.split(SEPARATOR);
  if (parts.length < 4) {
    throw new ValidationError(
      `Invalid dpk unique id (expected at least 4 ':'-separated segments): ${uniqueId}`,
    );
  }
  // Anchors: first = interfaceId, last = parameter, last-1 = paramsetKey.
  // The remainder (middle) is the channelAddress, which may contain colons.
  const interfaceId = parts[0] as string;
  const parameter = parts[parts.length - 1] as string;
  const paramsetKey = parts[parts.length - 2] as string;
  const channelAddress = parts.slice(1, parts.length - 2).join(SEPARATOR);
  return { interfaceId, channelAddress, paramsetKey, parameter };
}
