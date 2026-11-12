/**
 * Central-link protocol, taken from aiohomematic (SukramJ/aiohomematic, devel).
 *
 * Create / remove — `Channel.create_central_link` and `Channel.remove_central_link`
 * in `aiohomematic/model/device.py` call `CcuBackend.report_value_usage`
 * (`aiohomematic/client/backends/ccu.py`), which sends one XML-RPC call on the
 * channel's interface (HmIP-RF and BidCos-RF use the same method; there is no
 * `addLink` to a central address):
 *
 *   reportValueUsage(channelAddress, "PRESS_SHORT", refCounter)
 *
 * `refCounter` is `1` to create and `0` to remove. The value id and the metadata
 * key are `REPORT_VALUE_USAGE_VALUE_ID` / `REPORT_VALUE_USAGE_DATA` in
 * `aiohomematic/const.py` (`"PRESS_SHORT"` / `"reportValueUsageData"`).
 *
 * "Has a central link" is `Channel._has_central_link` in the same file: XML-RPC
 * `getMetadata(address, "reportValueUsageData")` and the integer `PRESS_SHORT`
 * entry is `> 0`. A metadata fault is treated as "no central link". It is not
 * inferred from `getLinks`.
 *
 * Direct links are `LinkCoordinator.get_device_links`
 * (`aiohomematic/central/coordinators/link.py`): XML-RPC
 * `getLinks(channelAddress, 0)`, an array of structs with `SENDER`, `RECEIVER`
 * and `NAME`.
 *
 * aiohomematic's `remove_central_link` also skips the XML-RPC call when JSON-RPC
 * `Channel.hasProgramIds` (`client/json_rpc.py` `has_program_ids`) is true.
 * `removeCentralLink` does not consult programs: a central link is cleared
 * whenever the metadata counter is `> 0`.
 */

import type { XmlRpcValue } from '../transport/xmlrpc/types.js';
import type { HmChannelLink } from './types.js';

/** `getMetadata` data id. aiohomematic `const.REPORT_VALUE_USAGE_DATA`. */
export const REPORT_VALUE_USAGE_DATA = 'reportValueUsageData';

/** Value id passed to `reportValueUsage`. aiohomematic `const.REPORT_VALUE_USAGE_VALUE_ID`. */
export const REPORT_VALUE_USAGE_VALUE_ID = 'PRESS_SHORT';

/** `getLinks` flags. aiohomematic `LinkCoordinator.get_device_links` passes `0`. */
export const GET_LINKS_FLAGS = 0;

/** `reportValueUsage` ref counter that creates a central link. */
export const REPORT_VALUE_USAGE_REF_CREATE = 1;

/** `reportValueUsage` ref counter that removes a central link. */
export const REPORT_VALUE_USAGE_REF_REMOVE = 0;

function isStruct(value: XmlRpcValue): value is { [key: string]: XmlRpcValue } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}

function structString(struct: { [key: string]: XmlRpcValue }, key: string): string | undefined {
  const value = struct[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Narrow a `getLinks` result to direct links. A non-array (aiohomematic skips
 * those) or an entry without `SENDER`/`RECEIVER` is dropped. A missing `NAME`
 * is `""` — never the address.
 */
export function parseChannelLinks(value: XmlRpcValue): HmChannelLink[] {
  if (!Array.isArray(value)) return [];
  const links: HmChannelLink[] = [];
  for (const entry of value) {
    if (!isStruct(entry)) continue;
    const sender = structString(entry, 'SENDER');
    const receiver = structString(entry, 'RECEIVER');
    if (sender === undefined || receiver === undefined) continue;
    const name = entry.NAME;
    links.push({ sender, receiver, name: typeof name === 'string' ? name : '' });
  }
  return links;
}

/**
 * True when `getMetadata(..., "reportValueUsageData")` reports `PRESS_SHORT > 0`
 * (`Channel._has_central_link`).
 */
export function metadataHasCentralLink(value: XmlRpcValue): boolean {
  if (!isStruct(value)) return false;
  const counter = value[REPORT_VALUE_USAGE_VALUE_ID];
  return typeof counter === 'number' && counter > 0;
}
