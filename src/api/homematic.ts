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
import type { HubFetcher } from '../central/hub/hub-fetcher.js';
import type { SystemVariable } from '../central/hub/sysvar.js';
import type { HmProgramRecord } from '../central/hub/program.js';
import type { InterfaceClient } from '../transport/interface-client.js';
import type { StorageBackend } from '../central/store/storage-backend.js';
import type { DeviceNode } from '../central/graph.js';
import type { ParameterData } from '../transport/xmlrpc/types.js';
import { Interface, ParamsetKey, isWritable } from '../support/constants.js';
import { ValidationError, DescriptionNotFoundError } from '../support/errors.js';
import { makeDpk, dpkToUniqueId, type DataPointKey } from '../support/dpk.js';
import { buildModel, buildDevice, interfaceFamilyOf } from '../model/model-builder.js';
import { GenericDataPoint } from '../model/data-point.js';
import { convertFromCcu, convertToCcu } from '../model/converter.js';
import { parameterSpecFromData } from '../central/graph.js';
import type { ModelDevice } from '../model/device.js';
import {
  buildCustomEntities,
  CustomEntity,
  ClimateEntity,
  SwitchEntity,
  DimmerEntity,
  CoverEntity,
  BlindEntity,
  IpLockEntity,
  RfLockEntity,
  type CustomEntityWriter,
  type ClimateMode,
} from '../model/custom/index.js';
import { TypedEventEmitter } from './emitter.js';
import type { HomematicEventMap } from './events.js';
import type {
  DataPointRef,
  HmChannel,
  HmConfigParam,
  HmCustomEntity,
  HmDataPoint,
  HmDevice,
  HmProgram,
  HmSysVar,
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
}

const DEFAULT_CENTRAL_NAME = 'nodehomematic';

/**
 * Module-level symbol marking the INTERNAL test-construction path. It is NOT
 * exported from the package entrypoint (`src/index.ts`), so it never reaches
 * the published surface; tests import it directly from this module.
 */
export const HOMEMATIC_TEST_INIT: unique symbol = Symbol('nodehomematic.test-init');

/**
 * Test-only injectables, forwarded into the {@link CentralUnit} the facade
 * builds. Never exported from the package entrypoint — referencing internal
 * transport/central types here would otherwise bleed them into the public
 * `.d.ts`. CRUCIAL: this type is referenced ONLY by the (non-exported)
 * {@link createHomematicForTest} free function, never by a member of the
 * {@link Homematic} class, so it cannot leak the internal type graph into the
 * published declaration of `Homematic`.
 */
export interface HomematicTestInjectables {
  /**
   * Inject a fully-constructed {@link CentralUnit}. When supplied it is used
   * verbatim and the other CCU options are ignored; only `interfaces` is still
   * validated so an empty/unknown configuration fails fast.
   */
  readonly central?: CentralUnit;
  readonly storageBackend?: StorageBackend;
  readonly makeInterfaceClient?: (iface: Interface) => InterfaceClient;
  readonly jsonClient?: JsonRpcClientLike;
}

/**
 * Module-private channel handing test injectables to the next {@link Homematic}
 * constructor call. Kept off the class so the published `Homematic` type never
 * references the internal {@link HomematicTestInjectables} graph. Marked with
 * {@link HOMEMATIC_TEST_INIT} as a defensive sanity check.
 */
let pendingTestInjectables:
  | { readonly [HOMEMATIC_TEST_INIT]: true; readonly injectables: HomematicTestInjectables }
  | undefined;

/**
 * INTERNAL test-construction helper. Builds a {@link Homematic} wiring its
 * {@link CentralUnit} from the supplied {@link HomematicTestInjectables}. NOT
 * exported from the package entrypoint; tests import it directly from this
 * module. The injectables travel through a module-private variable rather than
 * the public constructor signature, so the published `Homematic` declaration
 * stays free of internal types.
 */
export function createHomematicForTest(
  options: HomematicOptions,
  injectables: HomematicTestInjectables,
): Homematic {
  pendingTestInjectables = { [HOMEMATIC_TEST_INIT]: true, injectables };
  try {
    return new Homematic(options);
  } finally {
    pendingTestInjectables = undefined;
  }
}

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

/**
 * Build the {@link CentralUnit} backing a facade. Validates `interfaces`, then
 * either reuses an injected central (tests) or constructs a real one, forwarding
 * any test injectables. Injectables are empty for public construction.
 */
function buildCentral(
  options: HomematicOptions,
  injectables: HomematicTestInjectables,
): CentralUnit {
  const interfaces = options.interfaces.map(toInterface);
  if (interfaces.length === 0) {
    throw new ValidationError('At least one interface is required.');
  }
  if (injectables.central !== undefined) {
    return injectables.central;
  }
  return new CentralUnit({
    centralName: options.centralName ?? DEFAULT_CENTRAL_NAME,
    host: options.host,
    interfaces,
    callback: options.callback,
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(injectables.storageBackend !== undefined
      ? { storageBackend: injectables.storageBackend }
      : {}),
    ...(injectables.makeInterfaceClient !== undefined
      ? { makeInterfaceClient: injectables.makeInterfaceClient }
      : {}),
    ...(injectables.jsonClient !== undefined ? { jsonClient: injectables.jsonClient } : {}),
  });
}

export class Homematic {
  readonly #central: CentralUnit;
  readonly #emitter: TypedEventEmitter<HomematicEventMap>;
  /** Guard against re-entrant error emission when an `error` listener throws. */
  #emittingError = false;

  /** dpId (lowercased unique id) → live data point. */
  readonly #dataPointsById = new Map<string, GenericDataPoint>();
  /** Device address → model device. */
  readonly #devicesByAddress = new Map<string, ModelDevice>();

  /** Every live custom entity, in build order. */
  #customEntityList: CustomEntity[] = [];
  /** `device:channel` → live custom entity, for command routing. */
  readonly #customEntitiesByKey = new Map<string, CustomEntity>();

  readonly #unsubscribers: Array<() => void> = [];
  #started = false;

  // --- hub layer (Phase 5) ---------------------------------------------------
  /** Bound hub fetcher, or undefined when no JSON-RPC client is available. */
  #hub: HubFetcher | undefined;
  /** Snapshot of system variables, refreshed on start / refreshHub. */
  #sysvars: SystemVariable[] = [];
  /** Snapshot of programs, refreshed on start / refreshHub. */
  #programs: HmProgramRecord[] = [];
  /** Device address → its aggregated room names (union of its channels'). */
  #roomsByDevice = new Map<string, string[]>();
  /** Device address → its aggregated function names (union of its channels'). */
  #functionsByDevice = new Map<string, string[]>();

  /**
   * Build a facade that owns a real {@link CentralUnit} for `options`. (Tests
   * inject a pre-built central / transport stubs through the non-exported
   * {@link createHomematicForTest}, which never widens this public signature.)
   */
  public constructor(options: HomematicOptions) {
    const injectables = pendingTestInjectables?.injectables ?? {};
    this.#central = buildCentral(options, injectables);
    this.#emitter = new TypedEventEmitter<HomematicEventMap>((error) =>
      this.#onListenerError(error),
    );
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
    try {
      await this.#central.start();
      this.#rebuildModel(this.#central.registry.getAll());
      this.#subscribe();
      // Initial values may have been seeded by the central during start(),
      // before the facade built its model / subscribed. Backfill those data
      // points from the central's value cache so devices() shows values
      // immediately. Live pushes flow through the valueReceived subscription.
      this.#backfillSeededValues();
      await this.#initHub();
    } catch (error: unknown) {
      // Roll back so a failed start does not wedge the facade: a subsequent
      // start() attempt is allowed (and will call central.start() again).
      this.#started = false;
      throw error;
    }
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
    this.#customEntityList = [];
    this.#customEntitiesByKey.clear();
    this.#hub = undefined;
    this.#sysvars = [];
    this.#programs = [];
    this.#roomsByDevice.clear();
    this.#functionsByDevice.clear();
  }

  // --- public read surface --------------------------------------------------

  /**
   * An immutable snapshot of every known device. The `rooms`/`functions` carried
   * by each device are the union of the model's own metadata and the hub's
   * channel-address-keyed ReGa mapping (Phase 5), aggregated to the device.
   */
  public devices(): HmDevice[] {
    return [...this.#devicesByAddress.values()].map((device) =>
      toHmDevice(
        device,
        this.#roomsByDevice.get(device.address),
        this.#functionsByDevice.get(device.address),
      ),
    );
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
    if (spec === undefined) {
      throw new DescriptionNotFoundError(
        `No MASTER paramset description discovered for channel "${channelAddress}".`,
      );
    }
    const raw = await this.#central.readParamset(interfaceId, channelAddress, ParamsetKey.MASTER);
    const out: Record<string, HmValue> = {};
    for (const [parameter, value] of Object.entries(raw)) {
      const data = spec[parameter];
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

  // --- hub: system variables + programs -------------------------------------

  /**
   * An immutable snapshot of every known system variable (empty when no hub /
   * credentials). Refreshed at {@link Homematic.start} and {@link Homematic.refreshHub}.
   */
  public systemVariables(): HmSysVar[] {
    return this.#sysvars.map(toHmSysVar);
  }

  /** Read a single system variable's current value by name. Throws if no hub. */
  public async getSystemVariable(name: string): Promise<HmValue> {
    return this.#requireHub().getSystemVariable(name);
  }

  /**
   * Write a system variable by name. Validates against the snapshot BEFORE any
   * network call: an unknown or read-only variable throws {@link ValidationError}
   * (no write is attempted). Throws if no hub.
   */
  public async setSystemVariable(name: string, value: HmValue): Promise<void> {
    const hub = this.#requireHub();
    const sysvar = this.#sysvars.find((v) => v.name === name);
    if (sysvar === undefined) {
      throw new ValidationError(`Unknown system variable "${name}".`);
    }
    if (!sysvar.writable) {
      throw new ValidationError(`System variable "${name}" is read-only.`);
    }
    await hub.setSystemVariable(name, value);
  }

  /**
   * An immutable snapshot of every known program (empty when no hub). Refreshed
   * at {@link Homematic.start} and {@link Homematic.refreshHub}.
   */
  public programs(): HmProgram[] {
    return this.#programs.map(toHmProgram);
  }

  /** Execute a program, resolved by id or name from the snapshot. Throws if no hub. */
  public async runProgram(idOrName: string): Promise<void> {
    const hub = this.#requireHub();
    await hub.runProgram(this.#resolveProgramId(idOrName));
  }

  /** Enable/disable a program, resolved by id or name. Throws if no hub. */
  public async setProgramActive(idOrName: string, active: boolean): Promise<void> {
    const hub = this.#requireHub();
    await hub.setProgramActive(this.#resolveProgramId(idOrName), active);
  }

  /** Re-fetch the system-variable and program snapshots from the hub. Throws if no hub. */
  public async refreshHub(): Promise<void> {
    const hub = this.#requireHub();
    this.#sysvars = await hub.fetchSystemVariables();
    this.#programs = await hub.fetchPrograms();
  }

  // --- custom entities ------------------------------------------------------

  /**
   * An immutable snapshot of every live custom entity (Climate / Switch / Light
   * / Cover / Lock), each mapped to its public {@link HmCustomEntity} shape by
   * reading the entity's current getters. No functions leak into the snapshot;
   * issue commands through the typed command methods below.
   */
  public customEntities(): HmCustomEntity[] {
    return this.#customEntityList.map((entity) => toHmCustomEntity(entity));
  }

  /** Set a climate entity's target temperature (clamped to its range). */
  public async climateSetTemperature(
    device: string,
    channel: string | number,
    temperature: number,
  ): Promise<void> {
    await this.#climate(device, channel).setTemperature(temperature);
  }

  /** Set a climate entity's operating mode. */
  public async climateSetMode(
    device: string,
    channel: string | number,
    mode: ClimateMode,
  ): Promise<void> {
    await this.#climate(device, channel).setMode(mode);
  }

  /** Enable or disable a climate entity's boost mode. */
  public async climateSetBoost(
    device: string,
    channel: string | number,
    on: boolean,
  ): Promise<void> {
    await this.#climate(device, channel).setBoost(on);
  }

  /** Turn a switch entity on. */
  public async switchTurnOn(device: string, channel: string | number): Promise<void> {
    await this.#switch(device, channel).turnOn();
  }

  /** Turn a switch entity off. */
  public async switchTurnOff(device: string, channel: string | number): Promise<void> {
    await this.#switch(device, channel).turnOff();
  }

  /** Turn a light entity on (full brightness, or `brightness` 0..255 when given). */
  public async lightTurnOn(
    device: string,
    channel: string | number,
    brightness?: number,
  ): Promise<void> {
    const light = this.#light(device, channel);
    await (brightness === undefined ? light.turnOn() : light.turnOn(brightness));
  }

  /** Turn a light entity off. */
  public async lightTurnOff(device: string, channel: string | number): Promise<void> {
    await this.#light(device, channel).turnOff();
  }

  /** Set a light entity's brightness (0..255). */
  public async lightSetBrightness(
    device: string,
    channel: string | number,
    brightness: number,
  ): Promise<void> {
    await this.#light(device, channel).setBrightness(brightness);
  }

  /** Open a cover entity fully. */
  public async coverOpen(device: string, channel: string | number): Promise<void> {
    await this.#cover(device, channel).open();
  }

  /** Close a cover entity fully. */
  public async coverClose(device: string, channel: string | number): Promise<void> {
    await this.#cover(device, channel).close();
  }

  /** Stop a cover entity where it is. */
  public async coverStop(device: string, channel: string | number): Promise<void> {
    await this.#cover(device, channel).stop();
  }

  /** Move a cover entity to `position` (0..100). */
  public async coverSetPosition(
    device: string,
    channel: string | number,
    position: number,
  ): Promise<void> {
    await this.#cover(device, channel).setPosition(position);
  }

  /** Lock a lock entity. */
  public async lockLock(device: string, channel: string | number): Promise<void> {
    await this.#lock(device, channel).lock();
  }

  /** Unlock a lock entity. */
  public async lockUnlock(device: string, channel: string | number): Promise<void> {
    await this.#lock(device, channel).unlock();
  }

  /** Release a lock entity's latch (open). */
  public async lockOpen(device: string, channel: string | number): Promise<void> {
    await this.#lock(device, channel).open();
  }

  // --- internals ------------------------------------------------------------

  /**
   * Resolve the live custom entity for `(device, channel)`, asserting its
   * `kind`. `channel` may be a numeric index, a numeric string, or the full
   * channel address (normalised like the {@link DataPointRef} resolver). Throws
   * {@link ValidationError} when absent or of the wrong kind.
   */
  #entity(device: string, channel: string | number, expectedKind: string): CustomEntity {
    const channelAddress =
      typeof channel === 'string' && (channel.includes(':') || channel.startsWith(`${device}:`))
        ? channel
        : `${device}:${channel}`;
    const entity = this.#customEntitiesByKey.get(`${device}:${channelAddress}`);
    if (entity === undefined) {
      throw new ValidationError(`No custom entity for "${device}" channel "${channelAddress}".`);
    }
    if (entity.kind !== expectedKind) {
      throw new ValidationError(
        `Custom entity "${device}" channel "${channelAddress}" is a ${entity.kind}, not a ${expectedKind}.`,
      );
    }
    return entity;
  }

  #climate(device: string, channel: string | number): ClimateEntity {
    const entity = this.#entity(device, channel, 'climate');
    if (!(entity instanceof ClimateEntity)) {
      throw new ValidationError(`Custom entity for "${device}" is not a climate entity.`);
    }
    return entity;
  }

  #switch(device: string, channel: string | number): SwitchEntity {
    const entity = this.#entity(device, channel, 'switch');
    if (!(entity instanceof SwitchEntity)) {
      throw new ValidationError(`Custom entity for "${device}" is not a switch entity.`);
    }
    return entity;
  }

  #light(device: string, channel: string | number): DimmerEntity {
    const entity = this.#entity(device, channel, 'light');
    if (!(entity instanceof DimmerEntity)) {
      throw new ValidationError(`Custom entity for "${device}" is not a light entity.`);
    }
    return entity;
  }

  #cover(device: string, channel: string | number): CoverEntity {
    // Both 'cover' and 'blind' kinds are CoverEntity instances.
    const channelAddress =
      typeof channel === 'string' && (channel.includes(':') || channel.startsWith(`${device}:`))
        ? channel
        : `${device}:${channel}`;
    const entity = this.#customEntitiesByKey.get(`${device}:${channelAddress}`);
    if (entity === undefined || !(entity instanceof CoverEntity)) {
      throw new ValidationError(
        `No cover custom entity for "${device}" channel "${channelAddress}".`,
      );
    }
    return entity;
  }

  #lock(device: string, channel: string | number): IpLockEntity | RfLockEntity {
    const entity = this.#entity(device, channel, 'lock');
    if (entity instanceof IpLockEntity || entity instanceof RfLockEntity) {
      return entity;
    }
    throw new ValidationError(`Custom entity for "${device}" is not a lock entity.`);
  }

  /**
   * Route an error thrown by a public-event listener to the `error` event so it
   * is surfaced rather than swallowed. If the failing listener was itself an
   * `error` listener (or another `error` listener throws while we re-emit), we
   * fall back to `console.error` to avoid unbounded recursion.
   */
  #onListenerError(error: unknown): void {
    if (this.#emittingError) {
      console.error('nodehomematic: error event listener threw', error);
      return;
    }
    this.#emittingError = true;
    try {
      this.#emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.#emittingError = false;
    }
  }

  #rebuildModel(nodes: readonly DeviceNode[]): void {
    this.#dataPointsById.clear();
    this.#devicesByAddress.clear();
    for (const device of buildModel(nodes)) {
      this.#indexDevice(device);
    }
    this.#rebuildCustomEntities();
  }

  /**
   * Rebuild the custom-entity views from the current model. Each entity is wired
   * to {@link Homematic.#writeRaw} so commands flow through the same validated
   * send path as {@link Homematic.setValue}.
   */
  #rebuildCustomEntities(): void {
    const writer: CustomEntityWriter = (channelAddress, parameter, value) =>
      this.#writeRaw(channelAddress, parameter, value);
    const list: CustomEntity[] = [];
    this.#customEntitiesByKey.clear();
    for (const device of this.#devicesByAddress.values()) {
      for (const entity of buildCustomEntities(device, writer)) {
        list.push(entity);
        this.#customEntitiesByKey.set(
          `${entity.deviceAddress}:${entity.primaryChannelAddress}`,
          entity,
        );
      }
    }
    this.#customEntityList = list;
  }

  /**
   * Resolve the live data point for `(channelAddress, parameter)` and route a
   * write through the SAME validate + convert + send path as
   * {@link Homematic.setValue}: `dp.prepareWrite(value)` then `central.setValue`.
   */
  async #writeRaw(channelAddress: string, parameter: string, value: HmValue): Promise<void> {
    const deviceAddress = deviceAddressOf(channelAddress);
    const device = this.#devicesByAddress.get(deviceAddress);
    if (device === undefined) {
      throw new ValidationError(
        `Unknown device "${deviceAddress}" for channel "${channelAddress}".`,
      );
    }
    const dpId = dpkToUniqueId(
      makeDpk(device.interfaceId, channelAddress, ParamsetKey.VALUES, parameter),
    );
    const dp = this.#dataPointsById.get(dpId);
    if (dp === undefined) {
      throw new ValidationError(
        `Unknown data point ${channelAddress} ${parameter} on device "${deviceAddress}".`,
      );
    }
    const ccu = dp.prepareWrite(value);
    await this.#central.setValue(dp.dpk, ccu);
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

  /**
   * Apply any values the central has already cached (e.g. seeded at start before
   * the facade subscribed) onto the freshly-built data points. Silent: this is a
   * one-shot catch-up, not a live change, so it emits no `valueChanged`.
   */
  #backfillSeededValues(): void {
    for (const dp of this.#dataPointsById.values()) {
      const entry = this.#central.getValueEntry(dp.dpk);
      if (entry === undefined) continue;
      dp.applyCcuValue(entry.value, entry.at);
    }
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
    this.#rebuildCustomEntities();
    this.#emitter.emit('deviceAdded', { device: address });
  }

  #onDeviceRemoved(address: string): void {
    this.#removeDevice(address);
    this.#rebuildCustomEntities();
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
    // `channel` may be a numeric index, a numeric string, or already a full
    // channel address (`DEV:idx`). Only concatenate when it is a bare index;
    // otherwise use it verbatim to avoid producing `DEV:DEV:idx`.
    const channel = ref.channel;
    const channelAddress =
      typeof channel === 'string' && (channel.includes(':') || channel.startsWith(`${ref.device}:`))
        ? channel
        : `${ref.device}:${channel}`;
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

  /**
   * Best-effort hub initialisation, run at the end of {@link Homematic.start}.
   * If a {@link HubFetcher} is available (credentials present), fetch the
   * system-variable + program snapshots and the rooms/functions mapping. Every
   * fetch is isolated: a failure on the real CCU (e.g. a ReGa script that errors
   * on a given firmware) is logged and swallowed so it never wedges start().
   */
  async #initHub(): Promise<void> {
    this.#hub = this.#central.getHubFetcher();
    if (this.#hub === undefined) return;
    const hub = this.#hub;
    await this.#tryHub('system variables', async () => {
      this.#sysvars = await hub.fetchSystemVariables();
    });
    await this.#tryHub('programs', async () => {
      this.#programs = await hub.fetchPrograms();
    });
    await this.#tryHub('rooms/functions', async () => {
      const { rooms, functions } = await hub.fetchRoomsFunctions();
      this.#applyRoomsFunctions(rooms, functions);
    });
  }

  /** Run a best-effort hub fetch; isolate + log any failure (never throws). */
  async #tryHub(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error: unknown) {
      // Hub metadata is best-effort: a failure must not fail start(). Surface it
      // for diagnostics without re-emitting it as a public `error` event.
      console.warn(`nodehomematic: hub fetch "${label}" failed`, error);
    }
  }

  /**
   * Aggregate the channel-address-keyed rooms/functions maps to the DEVICE level
   * (union of every channel's entries, plus any entry keyed by the bare device
   * address) and store them for {@link Homematic.devices} to merge in. Replaces
   * any previous mapping.
   */
  #applyRoomsFunctions(
    rooms: ReadonlyMap<string, readonly string[]>,
    functions: ReadonlyMap<string, readonly string[]>,
  ): void {
    this.#roomsByDevice = aggregateByDevice(rooms);
    this.#functionsByDevice = aggregateByDevice(functions);
  }

  /** Resolve a program id-or-name to its id via the snapshot, or throw. */
  #resolveProgramId(idOrName: string): string {
    const byId = this.#programs.find((p) => p.id === idOrName);
    if (byId !== undefined) return byId.id;
    const byName = this.#programs.find((p) => p.name === idOrName);
    if (byName !== undefined) return byName.id;
    throw new ValidationError(`Unknown program "${idOrName}".`);
  }

  /** Return the bound hub fetcher, or throw if none (no credentials). */
  #requireHub(): HubFetcher {
    if (this.#hub === undefined) {
      throw new ValidationError('Hub is unavailable (no WebUI credentials configured).');
    }
    return this.#hub;
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
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

/**
 * Map a live {@link CustomEntity} to its public {@link HmCustomEntity} snapshot
 * by reading its current getters. The discriminated union is keyed by `kind`.
 */
function toHmCustomEntity(entity: CustomEntity): HmCustomEntity {
  const device = entity.deviceAddress;
  const channel = entity.primaryChannelAddress;
  if (entity instanceof ClimateEntity) {
    return {
      kind: 'climate',
      device,
      channel,
      currentTemperature: entity.currentTemperature,
      targetTemperature: entity.targetTemperature,
      currentHumidity: entity.currentHumidity,
      minTemp: entity.minTemp,
      maxTemp: entity.maxTemp,
      targetTemperatureStep: entity.targetTemperatureStep,
      mode: entity.mode,
      preset: entity.preset,
      activity: entity.activity,
    };
  }
  if (entity instanceof SwitchEntity) {
    return { kind: 'switch', device, channel, isOn: entity.isOn };
  }
  if (entity instanceof DimmerEntity) {
    return { kind: 'light', device, channel, isOn: entity.isOn, brightness: entity.brightness };
  }
  if (entity instanceof CoverEntity) {
    return {
      kind: entity.kind === 'blind' ? 'blind' : 'cover',
      device,
      channel,
      currentPosition: entity.currentPosition,
      isClosed: entity.isClosed,
      ...(entity instanceof BlindEntity ? { currentTiltPosition: entity.currentTiltPosition } : {}),
    };
  }
  if (entity instanceof IpLockEntity || entity instanceof RfLockEntity) {
    return { kind: 'lock', device, channel, isLocked: entity.isLocked };
  }
  throw new ValidationError(`Unsupported custom entity kind "${entity.kind}".`);
}

/**
 * Map a {@link ModelDevice} to its public snapshot, overlaying any hub-derived
 * `rooms`/`functions` (union with the model's own, de-duplicated, order-stable).
 */
function toHmDevice(
  device: ModelDevice,
  hubRooms?: readonly string[],
  hubFunctions?: readonly string[],
): HmDevice {
  const channels: HmChannel[] = device.channels.map((channel) => ({
    address: channel.address,
    index: channel.index,
    ...(channel.type !== undefined ? { type: channel.type } : {}),
    dataPoints: channel.dataPoints.map(toHmDataPoint),
  }));
  const rooms = unionStrings(device.rooms, hubRooms);
  const functions = unionStrings(device.functions, hubFunctions);
  return {
    address: device.address,
    type: device.type,
    ...(device.name !== undefined ? { name: device.name } : {}),
    ...(rooms !== undefined ? { rooms } : {}),
    ...(functions !== undefined ? { functions } : {}),
    channels,
  };
}

/** Map a {@link SystemVariable} to its public {@link HmSysVar} snapshot. */
function toHmSysVar(sysvar: SystemVariable): HmSysVar {
  return {
    id: sysvar.id,
    name: sysvar.name,
    type: sysvar.type,
    value: sysvar.value,
    writable: sysvar.writable,
    isInternal: sysvar.isInternal,
    ...(sysvar.unit !== undefined ? { unit: sysvar.unit } : {}),
    ...(sysvar.valueList !== undefined ? { valueList: sysvar.valueList } : {}),
    ...(sysvar.min !== undefined ? { min: sysvar.min } : {}),
    ...(sysvar.max !== undefined ? { max: sysvar.max } : {}),
  };
}

/** Map a {@link HmProgramRecord} to its public {@link HmProgram} snapshot. */
function toHmProgram(program: HmProgramRecord): HmProgram {
  return {
    id: program.id,
    name: program.name,
    isActive: program.isActive,
    isInternal: program.isInternal,
    ...(program.lastExecuteTime !== undefined ? { lastExecuteTime: program.lastExecuteTime } : {}),
  };
}

/**
 * Aggregate a channel-address-keyed map (`DEV:idx` → names) to the device level
 * (`DEV` → union of all its channels' names). An entry keyed by the bare device
 * address is included verbatim. Order-stable, de-duplicated.
 */
function aggregateByDevice(
  byChannel: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [address, names] of byChannel) {
    const deviceAddress = deviceAddressOf(address);
    const existing = out.get(deviceAddress) ?? [];
    for (const name of names) {
      if (!existing.includes(name)) existing.push(name);
    }
    out.set(deviceAddress, existing);
  }
  return out;
}

/**
 * Union two optional string lists into one (de-duplicated, order-stable: base
 * first, then any new extras). Returns `undefined` when both are empty so the
 * snapshot omits the field rather than carrying an empty array.
 */
function unionStrings(
  base: readonly string[] | undefined,
  extra: readonly string[] | undefined,
): readonly string[] | undefined {
  if ((base === undefined || base.length === 0) && (extra === undefined || extra.length === 0)) {
    return undefined;
  }
  const out: string[] = [];
  for (const name of base ?? []) {
    if (!out.includes(name)) out.push(name);
  }
  for (const name of extra ?? []) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
