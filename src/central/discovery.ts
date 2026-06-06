/**
 * Device discovery for a single CCU interface.
 *
 * The discovery sequence (mirrors aiohomematic):
 *  1. `listDevices()` → entries that are either devices (no PARENT) or channels
 *     (PARENT = device address). Each entry is stored in the device cache.
 *  2. For each CHANNEL entry, fetch its `VALUES` and `MASTER` paramset
 *     descriptions (SKIP `LINK` and any other paramset key) and store them in
 *     the paramset cache.
 *  3. Optionally merge human-facing metadata (names, rooms, functions) fetched
 *     from the CCU WebUI over JSON-RPC.
 *  4. Build an immutable {@link DeviceNode}[] from the populated caches.
 *
 * `warmStart` rebuilds the graph purely from already-populated caches without
 * issuing any source calls — used on a cache hit at start-up.
 *
 * All raw protocol data crosses a trust boundary: JSON-RPC responses are typed
 * as `unknown` and narrowed defensively with the helpers at the bottom of this
 * file. We never throw on a missing field; we extract what is present and skip
 * the rest.
 */

import { ParamsetKey } from '../support/constants.js';
import type { DeviceDescription, ParameterData } from '../transport/xmlrpc/types.js';
import type {
  DeviceDescriptionCache,
  ParamsetDescriptionCache,
} from './store/description-cache.js';
import {
  parameterSpecFromData,
  type ChannelNode,
  type DeviceNode,
  type ParameterSpec,
  type ParameterSpecs,
} from './graph.js';
import { JsonRpcMethod } from '../transport/jsonrpc/methods.js';

/**
 * The minimal slice of an interface client that discovery needs. The Phase 1
 * {@link import('../transport/interface-client.js').InterfaceClient} satisfies
 * this shape structurally, so tests can inject a lightweight fake.
 */
export interface DiscoverySource {
  readonly interfaceId: string;
  listDevices(): Promise<DeviceDescription[]>;
  getParamsetDescription(
    channelAddress: string,
    paramsetKey: string,
  ): Promise<Record<string, ParameterData>>;
}

/** The minimal JSON-RPC client slice needed to fetch device details. */
export interface DetailsJsonRpcClient {
  post(
    method: string,
    params?: Record<string, unknown>,
    opts?: { readonly sessionId?: string },
  ): Promise<unknown>;
}

/**
 * Human-facing metadata merged into the graph, keyed by device OR channel
 * address. Rooms/functions are usually attached to channel addresses by the
 * CCU; consumers can look up either level.
 */
export type DeviceDetails = {
  readonly nameByAddress: ReadonlyMap<string, string>;
  readonly roomsByAddress: ReadonlyMap<string, readonly string[]>;
  readonly functionsByAddress: ReadonlyMap<string, readonly string[]>;
};

/** Paramset keys discovery fetches and stores; everything else is skipped. */
const FETCHED_PARAMSET_KEYS: readonly string[] = [ParamsetKey.VALUES, ParamsetKey.MASTER];

/** True when a description entry represents a device (no parent). */
function isDeviceEntry(entry: DeviceDescription): boolean {
  return entry.PARENT === undefined || entry.PARENT === '';
}

/** Parse the channel index from a `DEV:idx` address; 0 when there is no suffix. */
function channelIndexOf(address: string): number {
  const colon = address.lastIndexOf(':');
  if (colon === -1) return 0;
  const parsed = Number.parseInt(address.slice(colon + 1), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Run discovery against a live source, populating both caches and the graph. */
export async function discoverInterface(opts: {
  readonly source: DiscoverySource;
  readonly deviceCache: DeviceDescriptionCache;
  readonly paramsetCache: ParamsetDescriptionCache;
  readonly details?: DeviceDetails;
}): Promise<DeviceNode[]> {
  const { source, deviceCache, paramsetCache, details } = opts;
  const interfaceId = source.interfaceId;

  const entries = await source.listDevices();

  // 1. Cache every entry (devices and channels alike).
  for (const entry of entries) {
    if (typeof entry.ADDRESS !== 'string' || entry.ADDRESS === '') continue;
    deviceCache.add(interfaceId, entry);
  }

  // 2. For each channel, fetch + cache its VALUES/MASTER paramsets (skip LINK).
  for (const entry of entries) {
    if (isDeviceEntry(entry)) continue;
    const channelAddress = entry.ADDRESS;
    if (typeof channelAddress !== 'string' || channelAddress === '') continue;
    const paramsets = entry.PARAMSETS ?? [];
    for (const key of paramsets) {
      if (!FETCHED_PARAMSET_KEYS.includes(key)) continue;
      const ps = await source.getParamsetDescription(channelAddress, key);
      paramsetCache.addParamset(interfaceId, channelAddress, key, ps);
    }
  }

  // 3 + 4. Build the graph from the now-populated caches.
  return buildGraph({ interfaceId, deviceCache, paramsetCache, ...(details ? { details } : {}) });
}

/** Rebuild the graph purely from the caches, issuing NO source calls. */
export function warmStart(opts: {
  readonly interfaceId: string;
  readonly deviceCache: DeviceDescriptionCache;
  readonly paramsetCache: ParamsetDescriptionCache;
  readonly details?: DeviceDetails;
}): DeviceNode[] {
  return buildGraph(opts);
}

/** Construct {@link DeviceNode}[] from cached descriptions + paramsets + details. */
function buildGraph(opts: {
  readonly interfaceId: string;
  readonly deviceCache: DeviceDescriptionCache;
  readonly paramsetCache: ParamsetDescriptionCache;
  readonly details?: DeviceDetails;
}): DeviceNode[] {
  const { interfaceId, deviceCache, paramsetCache, details } = opts;
  const all = deviceCache.getAll(interfaceId);

  const devices = all.filter(isDeviceEntry);
  const channelsByParent = new Map<string, DeviceDescription[]>();
  for (const entry of all) {
    if (isDeviceEntry(entry)) continue;
    const parent = entry.PARENT;
    if (typeof parent !== 'string' || parent === '') continue;
    const list = channelsByParent.get(parent);
    if (list === undefined) channelsByParent.set(parent, [entry]);
    else list.push(entry);
  }

  const nodes: DeviceNode[] = [];
  for (const device of devices) {
    const address = device.ADDRESS;
    if (typeof address !== 'string' || address === '') continue;

    const channelAddresses = collectChannelAddresses(device, channelsByParent.get(address) ?? []);
    const channels: ChannelNode[] = [];
    for (const channelAddress of channelAddresses) {
      const desc = deviceCache.get(interfaceId, channelAddress);
      channels.push(buildChannel(interfaceId, channelAddress, desc, paramsetCache, details));
    }

    nodes.push(buildDevice(interfaceId, device, channels, details));
  }
  return nodes;
}

/** Union of a device's CHILDREN and the channels whose PARENT points to it. */
function collectChannelAddresses(
  device: DeviceDescription,
  childEntries: readonly DeviceDescription[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (addr: unknown): void => {
    if (typeof addr !== 'string' || addr === '' || seen.has(addr)) return;
    seen.add(addr);
    ordered.push(addr);
  };
  for (const child of device.CHILDREN ?? []) push(child);
  for (const entry of childEntries) push(entry.ADDRESS);
  return ordered;
}

/** Build a single {@link ChannelNode} from its description + cached paramsets. */
function buildChannel(
  interfaceId: string,
  channelAddress: string,
  desc: DeviceDescription | undefined,
  paramsetCache: ParamsetDescriptionCache,
  details: DeviceDetails | undefined,
): ChannelNode {
  const parameters = new Map<string, ParameterSpecs>();
  for (const key of FETCHED_PARAMSET_KEYS) {
    const paramset = paramsetCache.getParamset(interfaceId, channelAddress, key);
    if (paramset === undefined) continue;
    for (const [parameter, data] of Object.entries(paramset)) {
      const spec = parameterSpecFromData(data);
      mergeSpec(parameters, parameter, key, spec);
    }
  }

  const node: ChannelNode = {
    address: channelAddress,
    index: channelIndexOf(channelAddress),
    parameters,
    ...(desc?.TYPE !== undefined ? { type: desc.TYPE } : {}),
    ...(desc?.DIRECTION !== undefined ? { direction: desc.DIRECTION } : {}),
  };
  // name/rooms/functions live on the device node; channel-level details, when
  // present, are intentionally not surfaced on ChannelNode (graph.ts shape).
  void details;
  return node;
}

/** Attach a spec to the per-parameter VALUES/MASTER record, preserving the other. */
function mergeSpec(
  parameters: Map<string, ParameterSpecs>,
  parameter: string,
  key: string,
  spec: ParameterSpec,
): void {
  const existing = parameters.get(parameter) ?? {};
  if (key === (ParamsetKey.VALUES as string)) {
    parameters.set(parameter, { ...existing, VALUES: spec });
  } else if (key === (ParamsetKey.MASTER as string)) {
    parameters.set(parameter, { ...existing, MASTER: spec });
  }
}

/** Build a {@link DeviceNode}, merging in details when present. */
function buildDevice(
  interfaceId: string,
  device: DeviceDescription,
  channels: readonly ChannelNode[],
  details: DeviceDetails | undefined,
): DeviceNode {
  const address = device.ADDRESS;
  const name = details?.nameByAddress.get(address);
  const rooms = details?.roomsByAddress.get(address);
  const functions = details?.functionsByAddress.get(address);

  // Real CCUs key device-update availability as `UPDATABLE`; tolerate the
  // legacy `FIRMWARE_UPDATABLE` alias too. Both are booleans (XML-RPC 1/0).
  const updatable = device.UPDATABLE ?? device.FIRMWARE_UPDATABLE;

  const node: DeviceNode = {
    address,
    type: device.TYPE,
    interfaceId,
    channels,
    raw: device,
    ...(device.FIRMWARE !== undefined ? { firmware: device.FIRMWARE } : {}),
    ...(device.AVAILABLE_FIRMWARE !== undefined
      ? { availableFirmware: device.AVAILABLE_FIRMWARE }
      : {}),
    ...(updatable !== undefined ? { updatable } : {}),
    ...(device.FIRMWARE_UPDATE_STATE !== undefined
      ? { firmwareUpdateState: device.FIRMWARE_UPDATE_STATE }
      : {}),
    ...(name !== undefined ? { name } : {}),
    ...(rooms !== undefined && rooms.length > 0 ? { rooms } : {}),
    ...(functions !== undefined && functions.length > 0 ? { functions } : {}),
  };
  return node;
}

// ---------------------------------------------------------------------------
// JSON-RPC details merge.
//
// IMPORTANT: the exact CCU JSON-RPC response shapes below are documented from
// aiohomematic + the RaspberryMatic WebUI and are only fully verifiable against
// real hardware. The parsing is deliberately defensive — every field is
// optional and a missing/oddly-typed field is skipped, never thrown on.
// ---------------------------------------------------------------------------

/**
 * Fetch and merge device/room/function metadata over JSON-RPC.
 *
 * Real CCU response shapes (confirmed against hardware):
 *  - `Device.listAllDetail` → array of
 *    `{ id, name, address, interface, type, channels: [{ id, name, address, index, channelType, ... }] }`.
 *    Device name is keyed by the device `address`; each channel has BOTH a
 *    numeric `id` (string) and an `address` (e.g. `001B9D89A09163:0`). We map
 *    both device- and channel-level `address → name`, and build a
 *    `channelId → channelAddress` index used to resolve rooms/functions.
 *  - `Room.getAll` → array of `{ id, name, description, channelIds: string[] }`
 *    where `channelIds` are the numeric channel IDs (matching channel `id`),
 *    NOT addresses. Each room name is attached to its member channels'
 *    addresses AND their derived device addresses (union, deduped).
 *  - `Subsection.getAll` → same shape as rooms but represents "functions".
 */
export async function mergeDetails(
  jsonClient: DetailsJsonRpcClient,
  sessionId?: string,
): Promise<DeviceDetails> {
  const opts = sessionId !== undefined ? { sessionId } : undefined;

  const nameByAddress = new Map<string, string>();
  const channelIdToAddress = new Map<string, string>();
  const roomsByAddress = new Map<string, string[]>();
  const functionsByAddress = new Map<string, string[]>();

  const detail = await safePost(jsonClient, JsonRpcMethod.DEVICE_LIST_ALL_DETAIL, opts);
  for (const item of asArray(detail)) {
    parseDeviceDetail(item, nameByAddress, channelIdToAddress);
  }

  const rooms = await safePost(jsonClient, JsonRpcMethod.ROOM_GET_ALL, opts);
  for (const item of asArray(rooms)) {
    parseGroup(item, channelIdToAddress, roomsByAddress);
  }

  const subsections = await safePost(jsonClient, JsonRpcMethod.SUBSECTION_GET_ALL, opts);
  for (const item of asArray(subsections)) {
    parseGroup(item, channelIdToAddress, functionsByAddress);
  }

  return { nameByAddress, roomsByAddress, functionsByAddress };
}

/** Post a JSON-RPC method, returning `null` (not throwing) on any failure. */
async function safePost(
  jsonClient: DetailsJsonRpcClient,
  method: string,
  opts: { readonly sessionId?: string } | undefined,
): Promise<unknown> {
  try {
    return await jsonClient.post(method, undefined, opts);
  } catch {
    return null;
  }
}

/**
 * Map a single `Device.listAllDetail` entry's device + channel names AND index
 * every channel's numeric `id → address` so rooms/functions can join later.
 */
function parseDeviceDetail(
  item: unknown,
  nameByAddress: Map<string, string>,
  channelIdToAddress: Map<string, string>,
): void {
  const record = asRecord(item);
  if (record === undefined) return;
  const address = asString(record.address);
  const name = asString(record.name);
  if (address !== undefined && name !== undefined) nameByAddress.set(address, name);

  for (const channel of asArray(record.channels)) {
    const ch = asRecord(channel);
    if (ch === undefined) continue;
    const chAddress = asString(ch.address);
    if (chAddress === undefined) continue;
    const chName = asString(ch.name);
    if (chName !== undefined) nameByAddress.set(chAddress, chName);
    const chId = asString(ch.id);
    if (chId !== undefined) channelIdToAddress.set(chId, chAddress);
  }
}

/** Derive a device address from a channel address by stripping the `:index` suffix. */
function deviceAddressOf(channelAddress: string): string {
  const colon = channelAddress.lastIndexOf(':');
  return colon === -1 ? channelAddress : channelAddress.slice(0, colon);
}

/** Append `name` to `address`'s list in `into`, deduping. */
function addGroupName(into: Map<string, string[]>, address: string, name: string): void {
  const existing = into.get(address);
  if (existing === undefined) into.set(address, [name]);
  else if (!existing.includes(name)) existing.push(name);
}

/**
 * Map a single room/subsection entry: its `name` is attached to every member
 * channel's ADDRESS and its derived DEVICE address. Members are numeric channel
 * `id`s in `channelIds`, resolved to addresses via `channelIdToAddress`; unknown
 * ids are skipped (no bogus entry). `channelAddresses`/`members` are accepted as
 * fallbacks and, when already address-shaped, used directly.
 */
function parseGroup(
  item: unknown,
  channelIdToAddress: Map<string, string>,
  into: Map<string, string[]>,
): void {
  const record = asRecord(item);
  if (record === undefined) return;
  const name = asString(record.name);
  if (name === undefined) return;

  const idMembers = asArray(record.channelIds);
  for (const member of idMembers) {
    const channelId = asString(member);
    if (channelId === undefined) continue;
    const channelAddress = channelIdToAddress.get(channelId);
    if (channelAddress === undefined) continue; // unknown id → skip, no throw
    addGroupName(into, channelAddress, name);
    addGroupName(into, deviceAddressOf(channelAddress), name);
  }

  // Fallbacks for CCUs/responses that key members by address directly.
  const addressMembers = firstArray(record.channelAddresses, record.members);
  for (const member of addressMembers) {
    const channelAddress = asString(member);
    if (channelAddress === undefined) continue;
    addGroupName(into, channelAddress, name);
    addGroupName(into, deviceAddressOf(channelAddress), name);
  }
}

// --- narrowing helpers (trust boundary) ------------------------------------

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstArray(...candidates: readonly unknown[]): unknown[] {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}
