/**
 * {@link Homematic} — the public, transport-agnostic facade of the library.
 *
 * It wraps the internal {@link CentralUnit} (Phase 1 transport + Phase 2 device
 * graph + reconnection) and exposes a clean, event-driven surface: a global
 * `valueChanged` stream, lifecycle events, immutable device snapshots, a
 * validated `setValue`, and device-configuration (MASTER paramset) building
 * blocks. No transport/central/model types leak through its signatures.
 *
 * On {@link Homematic.start} it builds the domain model from the central's
 * registry, indexes every {@link GenericDataPoint} by id, and subscribes to the
 * central's {@link EventBus}, re-emitting each internal event as a typed public
 * event through the {@link TypedEventEmitter}.
 */

import { CentralUnit, type JsonRpcClientLike } from '../central/central-unit.js';
import type { InterfaceClient } from '../transport/interface-client.js';
import type { StorageBackend } from '../central/store/storage-backend.js';
import type { DeviceNode } from '../central/graph.js';
import type { ParameterData } from '../transport/xmlrpc/types.js';
import { Interface, ParamsetKey, isWritable } from '../support/constants.js';
import { ValidationError } from '../support/errors.js';
import { makeDpk, dpkToUniqueId, type DataPointKey } from '../support/dpk.js';
import { buildModel, buildDevice, interfaceFamilyOf } from '../model/model-builder.js';
import { GenericDataPoint } from '../model/data-point.js';
import { convertFromCcu, convertToCcu } from '../model/converter.js';
import { parameterSpecFromData } from '../central/graph.js';
import type { ModelDevice } from '../model/device.js';
import { TypedEventEmitter } from './emitter.js';
import type { HomematicEventMap } from './events.js';
import type {
  DataPointRef,
  HmChannel,
  HmConfigParam,
  HmDataPoint,
  HmDevice,
  HmValue,
} from './types.js';

/** Local callback-server binding for the facade. */
export interface HomematicCallback {
  readonly host: string;
  readonly port: number;
}

/** WebUI credentials for JSON-RPC name/room metadata. */
export interface HomematicCredentials {
  readonly username: string;
  readonly password: string;
}

/** Cache directory / toggle. */
export interface HomematicCache {
  readonly dir?: string;
  readonly enabled?: boolean;
}

/** Construction options for {@link Homematic}. */
export interface HomematicOptions {
  /** CCU host name or IP. */
  readonly host: string;
  /** Interface names, e.g. `'HmIP-RF'`, `'BidCos-RF'`. */
  readonly interfaces: readonly string[];
  readonly credentials?: HomematicCredentials;
  readonly callback: HomematicCallback;
  readonly cache?: HomematicCache;
  readonly tls?: boolean;
  /** Logical central name; defaults to `'nodehomematic'`. */
  readonly centralName?: string;

  // --- injectables (tests), forwarded verbatim to the CentralUnit ----------
  readonly storageBackend?: StorageBackend;
  readonly makeInterfaceClient?: (iface: Interface) => InterfaceClient;
  readonly jsonClient?: JsonRpcClientLike;
  /**
   * Inject a fully-constructed {@link CentralUnit} (tests). When supplied, it is
   * used verbatim and the other CCU options are ignored; only `interfaces` is
   * still validated so an empty/unknown configuration fails fast.
   */
  readonly central?: CentralUnit;
}

const DEFAULT_CENTRAL_NAME = 'nodehomematic';

/** Map a public interface string to the internal {@link Interface} enum. */
function toInterface(name: string): Interface {
  const match = (Object.values(Interface) as string[]).includes(name)
    ? (name as Interface)
    : undefined;
  if (match === undefined) {
    throw new ValidationError(`Unknown interface "${name}".`);
  }
  return match;
}

/** Device address owning a channel address (`DEV:idx` → `DEV`). */
function deviceAddressOf(channelAddress: string): string {
  const colon = channelAddress.lastIndexOf(':');
  return colon === -1 ? channelAddress : channelAddress.slice(0, colon);
}

export class Homematic {
  readonly #central: CentralUnit;
  readonly #emitter = new TypedEventEmitter<HomematicEventMap>();

  /** dpId (lowercased unique id) → live data point. */
  readonly #dataPointsById = new Map<string, GenericDataPoint>();
  /** Device address → model device. */
  readonly #devicesByAddress = new Map<string, ModelDevice>();

  readonly #unsubscribers: Array<() => void> = [];
  #started = false;

  public constructor(options: HomematicOptions) {
    const interfaces = options.interfaces.map(toInterface);
    if (interfaces.length === 0) {
      throw new ValidationError('At least one interface is required.');
    }
    if (options.central !== undefined) {
      this.#central = options.central;
      return;
    }
    this.#central = new CentralUnit({
      centralName: options.centralName ?? DEFAULT_CENTRAL_NAME,
      host: options.host,
      interfaces,
      callback: options.callback,
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
      ...(options.cache !== undefined ? { cache: options.cache } : {}),
      ...(options.tls !== undefined ? { tls: options.tls } : {}),
      ...(options.storageBackend !== undefined ? { storageBackend: options.storageBackend } : {}),
      ...(options.makeInterfaceClient !== undefined
        ? { makeInterfaceClient: options.makeInterfaceClient }
        : {}),
      ...(options.jsonClient !== undefined ? { jsonClient: options.jsonClient } : {}),
    });
  }

  // --- public event API -----------------------------------------------------

  /** Subscribe to a public event. Returns an unsubscribe function. */
  public on<K extends keyof HomematicEventMap>(
    event: K,
    listener: (payload: HomematicEventMap[K]) => void,
  ): () => void {
    return this.#emitter.on(event, listener);
  }

  /** Subscribe to a public event for a single delivery. */
  public once<K extends keyof HomematicEventMap>(
    event: K,
    listener: (payload: HomematicEventMap[K]) => void,
  ): () => void {
    return this.#emitter.once(event, listener);
  }

  /** Remove a previously-registered public event listener. */
  public off<K extends keyof HomematicEventMap>(
    event: K,
    listener: (payload: HomematicEventMap[K]) => void,
  ): void {
    this.#emitter.off(event, listener);
  }

  // --- lifecycle ------------------------------------------------------------

  /** Start the central, build the model from its registry, and subscribe. */
  public async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#central.start();
    this.#rebuildModel(this.#central.registry.getAll());
    this.#subscribe();
  }

  /** Stop the central and clear all subscriptions and the model index. */
  public async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    for (const off of this.#unsubscribers) off();
    this.#unsubscribers.length = 0;
    await this.#central.stop();
    this.#dataPointsById.clear();
    this.#devicesByAddress.clear();
  }

  // --- public read surface --------------------------------------------------

  /** An immutable snapshot of every known device. */
  public devices(): HmDevice[] {
    return [...this.#devicesByAddress.values()].map(toHmDevice);
  }

  /** Current value of a data point (resolving the ref). */
  public getValue(ref: DataPointRef): HmValue {
    return this.#resolveDataPoint(ref).value;
  }

  /**
   * Validate + convert `value` against the data point's metadata (throwing
   * BEFORE any network call on an invalid value), then write it to the CCU.
   */
  public async setValue(ref: DataPointRef, value: HmValue): Promise<void> {
    const dp = this.#resolveDataPoint(ref);
    const ccu = dp.prepareWrite(value);
    await this.#central.setValue(dp.dpk, ccu);
  }

  // --- device configuration (MASTER paramset) -------------------------------

  /**
   * The MASTER configuration parameters of a channel, with the metadata needed
   * to render a form. Empty array when nothing is known for the channel.
   */
  public getConfigParams(channelAddress: string): HmConfigParam[] {
    const interfaceId = this.#interfaceIdForChannel(channelAddress);
    const spec = this.#central.getParamsetSpec(interfaceId, channelAddress, ParamsetKey.MASTER);
    if (spec === undefined) return [];
    return Object.entries(spec).map(([parameter, data]) => toConfigParam(parameter, data));
  }

  /** Read and convert the current MASTER configuration values of a channel. */
  public async getConfig(channelAddress: string): Promise<Record<string, HmValue>> {
    const interfaceId = this.#interfaceIdForChannel(channelAddress);
    const spec = this.#central.getParamsetSpec(interfaceId, channelAddress, ParamsetKey.MASTER);
    const raw = await this.#central.readParamset(interfaceId, channelAddress, ParamsetKey.MASTER);
    const out: Record<string, HmValue> = {};
    for (const [parameter, value] of Object.entries(raw)) {
      const data = spec?.[parameter];
      out[parameter] =
        data === undefined
          ? coerceUnknownToHmValue(value)
          : convertFromCcu(parameterSpecFromData(data), value);
    }
    return out;
  }

  /**
   * Validate + convert every value against its MASTER spec (throwing BEFORE any
   * network call on an invalid/unknown parameter), then write them all in ONE
   * `putParamset`.
   */
  public async setConfig(channelAddress: string, values: Record<string, HmValue>): Promise<void> {
    const interfaceId = this.#interfaceIdForChannel(channelAddress);
    const spec = this.#central.getParamsetSpec(interfaceId, channelAddress, ParamsetKey.MASTER);
    const family = interfaceFamilyOf(interfaceId);
    const enumAsIndex = family === 'HM';
    const ccuValues: Record<string, boolean | number | string> = {};
    for (const [parameter, value] of Object.entries(values)) {
      const data = spec?.[parameter];
      if (data === undefined) {
        throw new ValidationError(
          `Unknown MASTER parameter "${parameter}" for channel "${channelAddress}".`,
        );
      }
      ccuValues[parameter] = convertToCcu(parameterSpecFromData(data), value, { enumAsIndex });
    }
    await this.#central.writeParamset(interfaceId, channelAddress, ParamsetKey.MASTER, ccuValues);
  }

  // --- internals ------------------------------------------------------------

  #rebuildModel(nodes: readonly DeviceNode[]): void {
    this.#dataPointsById.clear();
    this.#devicesByAddress.clear();
    for (const device of buildModel(nodes)) {
      this.#indexDevice(device);
    }
  }

  #indexDevice(device: ModelDevice): void {
    this.#devicesByAddress.set(device.address, device);
    for (const dp of device.allDataPoints()) {
      this.#dataPointsById.set(dp.id, dp);
    }
  }

  #removeDevice(address: string): void {
    const device = this.#devicesByAddress.get(address);
    if (device === undefined) return;
    for (const dp of device.allDataPoints()) {
      this.#dataPointsById.delete(dp.id);
    }
    this.#devicesByAddress.delete(address);
  }

  #subscribe(): void {
    const bus = this.#central.eventBus;
    this.#unsubscribers.push(
      bus.subscribe({
        type: 'valueReceived',
        handler: (event) => this.#onValueReceived(event.dpk, event.value, event.receivedAt),
      }),
      bus.subscribe({
        type: 'deviceAdded',
        handler: (event) => this.#onDeviceAdded(event.address),
      }),
      bus.subscribe({
        type: 'deviceRemoved',
        handler: (event) => this.#onDeviceRemoved(event.address),
      }),
      bus.subscribe({
        type: 'connectionStateChanged',
        handler: (event) =>
          this.#emitter.emit('connection', {
            interfaceId: event.interfaceId,
            state: event.state,
          }),
      }),
      bus.subscribe({
        type: 'systemError',
        handler: (event) =>
          this.#emitter.emit(
            'error',
            new Error(`[${event.interfaceId}] system error ${event.code}: ${event.message}`),
          ),
      }),
      bus.subscribe({
        type: 'ready',
        handler: () => this.#emitter.emit('ready'),
      }),
    );
  }

  #onValueReceived(dpk: DataPointKey, value: unknown, receivedAt: number): void {
    const dp = this.#dataPointsById.get(dpkToUniqueId(dpk));
    if (dp === undefined) return;
    const result = dp.applyCcuValue(value, receivedAt);
    if (!result.changed) return;
    const channel = dp.dpk.channelAddress;
    this.#emitter.emit('valueChanged', {
      dpId: dp.id,
      device: deviceAddressOf(channel),
      channel,
      parameter: dp.parameter,
      value: result.next,
      prevValue: result.prev,
      ts: receivedAt,
    });
  }

  #onDeviceAdded(address: string): void {
    const node = this.#central.registry.get(address);
    if (node !== undefined) {
      this.#removeDevice(address);
      this.#indexDevice(buildDevice(node));
    }
    this.#emitter.emit('deviceAdded', { device: address });
  }

  #onDeviceRemoved(address: string): void {
    this.#removeDevice(address);
    this.#emitter.emit('deviceRemoved', { device: address });
  }

  /** Resolve a {@link DataPointRef} to its live {@link GenericDataPoint}. */
  #resolveDataPoint(ref: DataPointRef): GenericDataPoint {
    if (typeof ref === 'string') {
      const dp = this.#dataPointsById.get(ref.toLowerCase());
      if (dp === undefined) {
        throw new ValidationError(`Unknown data point id "${ref}".`);
      }
      return dp;
    }
    const channelAddress = `${ref.device}:${ref.channel}`;
    const device = this.#devicesByAddress.get(ref.device);
    if (device === undefined) {
      throw new ValidationError(`Unknown device "${ref.device}".`);
    }
    const dpId = dpkToUniqueId(
      makeDpk(device.interfaceId, channelAddress, ParamsetKey.VALUES, ref.parameter),
    );
    const dp = this.#dataPointsById.get(dpId);
    if (dp === undefined) {
      throw new ValidationError(
        `Unknown data point ${channelAddress} ${ref.parameter} on device "${ref.device}".`,
      );
    }
    return dp;
  }

  /** Find the interfaceId owning a channel via its parent device. */
  #interfaceIdForChannel(channelAddress: string): string {
    const deviceAddress = deviceAddressOf(channelAddress);
    const device = this.#devicesByAddress.get(deviceAddress);
    if (device === undefined) {
      throw new ValidationError(
        `Unknown device "${deviceAddress}" for channel "${channelAddress}".`,
      );
    }
    return device.interfaceId;
  }
}

/** Map a {@link ParameterData} to a public {@link HmConfigParam}. */
function toConfigParam(parameter: string, data: ParameterData): HmConfigParam {
  const operations = data.OPERATIONS ?? 0;
  return {
    parameter,
    type: data.TYPE,
    flags: data.FLAGS ?? 0,
    writable: isWritable(operations),
    ...(typeof data.MIN === 'number' ? { min: data.MIN } : {}),
    ...(typeof data.MAX === 'number' ? { max: data.MAX } : {}),
    ...(data.DEFAULT !== undefined ? { default: coerceUnknownToHmValue(data.DEFAULT) } : {}),
    ...(data.UNIT !== undefined ? { unit: data.UNIT } : {}),
    ...(data.VALUE_LIST !== undefined ? { valueList: data.VALUE_LIST } : {}),
  };
}

/** Reduce an untrusted CCU scalar to an {@link HmValue}. */
function coerceUnknownToHmValue(value: unknown): HmValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') return Number(value);
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** Map a {@link GenericDataPoint} to its public snapshot. */
function toHmDataPoint(dp: GenericDataPoint): HmDataPoint {
  const min = dp.min;
  const max = dp.max;
  return {
    id: dp.id,
    parameter: dp.parameter,
    type: dp.type,
    value: dp.value,
    readable: dp.readable,
    writable: dp.writable,
    hasEvents: dp.hasEvents,
    ...(dp.unit !== undefined ? { unit: dp.unit } : {}),
    ...(dp.valueList !== undefined ? { valueList: dp.valueList } : {}),
    ...(typeof min === 'number' ? { min } : {}),
    ...(typeof max === 'number' ? { max } : {}),
  };
}

/** Map a {@link ModelDevice} to its public snapshot. */
function toHmDevice(device: ModelDevice): HmDevice {
  const channels: HmChannel[] = device.channels.map((channel) => ({
    address: channel.address,
    index: channel.index,
    ...(channel.type !== undefined ? { type: channel.type } : {}),
    dataPoints: channel.dataPoints.map(toHmDataPoint),
  }));
  return {
    address: device.address,
    type: device.type,
    ...(device.name !== undefined ? { name: device.name } : {}),
    ...(device.rooms !== undefined ? { rooms: device.rooms } : {}),
    ...(device.functions !== undefined ? { functions: device.functions } : {}),
    channels,
  };
}
