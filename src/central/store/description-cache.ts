/**
 * Persistent description caches: device descriptions and paramset descriptions.
 *
 * Both caches share the same persistence machinery:
 *  - A `{ schemaVersion, data }` envelope on disk. On load, a mismatched
 *    `schemaVersion` (or any parse failure) discards the on-disk data and the
 *    cache stays empty — invalidation is by SCHEMA VERSION, never by age.
 *  - A deterministic, key-sorted JSON serialization so the sha256 `contentHash`
 *    is stable across insertion order; `saveIfChanged` only writes when the
 *    hash differs from the last saved one.
 *
 * The caches store the raw transport-layer shapes (`DeviceDescription`,
 * `ParameterData`); the graph/model layer derives typed nodes from them.
 */

import { createHash } from 'node:crypto';
import type { StorageBackend } from './storage-backend.js';
import type { DeviceDescription, ParameterData } from '../../transport/xmlrpc/types.js';

/** Outcome of a cache {@link DescriptionCacheBase.load}. */
export type LoadResult = 'loaded' | 'empty' | 'version-mismatch' | 'fail';

/** Persisted envelope wrapping the cache data with its schema version. */
interface Envelope {
  readonly schemaVersion: number;
  readonly data: unknown;
}

/** Recursively serialize a value with object keys sorted, for a stable hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Shared persistence/hash/version machinery for the description caches. */
abstract class DescriptionCacheBase<TData> {
  protected abstract readonly schemaVersion: number;
  private lastSavedHash: string | null = null;

  protected constructor(
    private readonly backend: StorageBackend,
    private readonly fileName: string,
  ) {}

  /**
   * Seed the "last saved" baseline to the current (empty) content so a pristine
   * cache reports no unsaved changes. Subclasses MUST call this once their data
   * fields are initialised (the base constructor cannot, as it runs before the
   * subclass field initialisers).
   */
  protected seedBaseline(): void {
    this.lastSavedHash = this.contentHash();
  }

  /** Snapshot of the in-memory data in a JSON-serializable form. */
  protected abstract toData(): TData;

  /** Replace the in-memory data from a previously persisted snapshot. */
  protected abstract fromData(data: unknown): void;

  /** Reset the in-memory data to empty. */
  protected abstract resetData(): void;

  /** sha256 of the deterministic serialization of the current data. */
  public contentHash(): string {
    return createHash('sha256').update(stableStringify(this.toData())).digest('hex');
  }

  /** True if the current content differs from the last persisted snapshot. */
  public get hasUnsavedChanges(): boolean {
    return this.contentHash() !== this.lastSavedHash;
  }

  /**
   * Load the cache from the backend. On version mismatch or parse failure the
   * cache is left empty and the corresponding status is returned.
   */
  public async load(): Promise<LoadResult> {
    const raw = await this.backend.load(this.fileName);
    if (raw === null) return 'empty';
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      this.resetData();
      return 'fail';
    }
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      typeof envelope.schemaVersion !== 'number'
    ) {
      this.resetData();
      return 'fail';
    }
    if (envelope.schemaVersion !== this.schemaVersion) {
      this.resetData();
      return 'version-mismatch';
    }
    try {
      this.fromData(envelope.data);
    } catch {
      this.resetData();
      return 'fail';
    }
    this.lastSavedHash = this.contentHash();
    return 'loaded';
  }

  /** Persist the cache unconditionally. */
  public async saveAll(): Promise<void> {
    const envelope: Envelope = { schemaVersion: this.schemaVersion, data: this.toData() };
    await this.backend.save(this.fileName, JSON.stringify(envelope));
    this.lastSavedHash = this.contentHash();
  }

  /** Persist only if the content hash changed since the last save. */
  public async saveIfChanged(): Promise<void> {
    if (this.contentHash() === this.lastSavedHash) return;
    await this.saveAll();
  }
}

/** Persisted shape: interfaceId → address → DeviceDescription. */
type DeviceData = Record<string, Record<string, DeviceDescription>>;

/**
 * Cache of {@link DeviceDescription}s, keyed by interface then address.
 * Addresses include both device addresses (`VCU1`) and channel addresses
 * (`VCU1:1`).
 */
export class DeviceDescriptionCache extends DescriptionCacheBase<DeviceData> {
  public static readonly SCHEMA_VERSION = 1;
  protected readonly schemaVersion = DeviceDescriptionCache.SCHEMA_VERSION;

  private byInterface = new Map<string, Map<string, DeviceDescription>>();

  public constructor(backend: StorageBackend, fileName: string) {
    super(backend, fileName);
    this.seedBaseline();
  }

  /** Add or replace a description for `desc.ADDRESS` under `interfaceId`. */
  public add(interfaceId: string, desc: DeviceDescription): void {
    let forIface = this.byInterface.get(interfaceId);
    if (forIface === undefined) {
      forIface = new Map<string, DeviceDescription>();
      this.byInterface.set(interfaceId, forIface);
    }
    forIface.set(desc.ADDRESS, desc);
  }

  /** Get a single description by interface and address. */
  public get(interfaceId: string, address: string): DeviceDescription | undefined {
    return this.byInterface.get(interfaceId)?.get(address);
  }

  /** All descriptions for an interface (devices and channels). */
  public getAll(interfaceId: string): DeviceDescription[] {
    const forIface = this.byInterface.get(interfaceId);
    return forIface === undefined ? [] : [...forIface.values()];
  }

  /** All known interface ids. */
  public getAllInterfaces(): string[] {
    return [...this.byInterface.keys()];
  }

  /** Remove a device and all of its channel addresses (`address:*`). */
  public removeDevice(interfaceId: string, address: string): void {
    const forIface = this.byInterface.get(interfaceId);
    if (forIface === undefined) return;
    const channelPrefix = `${address}:`;
    for (const key of [...forIface.keys()]) {
      if (key === address || key.startsWith(channelPrefix)) {
        forIface.delete(key);
      }
    }
  }

  protected toData(): DeviceData {
    const data: DeviceData = {};
    for (const [iface, forIface] of this.byInterface) {
      const addresses: Record<string, DeviceDescription> = {};
      for (const [address, desc] of forIface) {
        addresses[address] = desc;
      }
      data[iface] = addresses;
    }
    return data;
  }

  protected fromData(data: unknown): void {
    const next = new Map<string, Map<string, DeviceDescription>>();
    const record = (data ?? {}) as Record<string, Record<string, DeviceDescription>>;
    for (const [iface, addresses] of Object.entries(record)) {
      const forIface = new Map<string, DeviceDescription>();
      for (const [address, desc] of Object.entries(addresses)) {
        forIface.set(address, desc);
      }
      next.set(iface, forIface);
    }
    this.byInterface = next;
  }

  protected resetData(): void {
    this.byInterface = new Map<string, Map<string, DeviceDescription>>();
  }
}

/** A paramset is a record of parameter name → its {@link ParameterData}. */
type Paramset = Record<string, ParameterData>;
/** Persisted shape: interfaceId → channelAddress → paramsetKey → Paramset. */
type ParamsetData = Record<string, Record<string, Record<string, Paramset>>>;

/**
 * Cache of paramset descriptions, keyed by interface → channel address →
 * paramset key → parameter → {@link ParameterData}.
 */
export class ParamsetDescriptionCache extends DescriptionCacheBase<ParamsetData> {
  public static readonly SCHEMA_VERSION = 1;
  protected readonly schemaVersion = ParamsetDescriptionCache.SCHEMA_VERSION;

  private byInterface = new Map<string, Map<string, Map<string, Paramset>>>();

  public constructor(backend: StorageBackend, fileName: string) {
    super(backend, fileName);
    this.seedBaseline();
  }

  private paramsetMap(interfaceId: string, channelAddress: string): Map<string, Paramset> {
    let forIface = this.byInterface.get(interfaceId);
    if (forIface === undefined) {
      forIface = new Map<string, Map<string, Paramset>>();
      this.byInterface.set(interfaceId, forIface);
    }
    let forChannel = forIface.get(channelAddress);
    if (forChannel === undefined) {
      forChannel = new Map<string, Paramset>();
      forIface.set(channelAddress, forChannel);
    }
    return forChannel;
  }

  /** Add a single parameter's data into a paramset. */
  public add(
    interfaceId: string,
    channelAddress: string,
    paramsetKey: string,
    parameter: string,
    data: ParameterData,
  ): void {
    const forChannel = this.paramsetMap(interfaceId, channelAddress);
    const existing = forChannel.get(paramsetKey);
    forChannel.set(paramsetKey, { ...(existing ?? {}), [parameter]: data });
  }

  /** Add or replace a whole paramset record at once. */
  public addParamset(
    interfaceId: string,
    channelAddress: string,
    paramsetKey: string,
    paramset: Paramset,
  ): void {
    this.paramsetMap(interfaceId, channelAddress).set(paramsetKey, { ...paramset });
  }

  /** Get a paramset record (parameter → data) for a channel, or undefined. */
  public getParamset(
    interfaceId: string,
    channelAddress: string,
    paramsetKey: string,
  ): Paramset | undefined {
    return this.byInterface.get(interfaceId)?.get(channelAddress)?.get(paramsetKey);
  }

  /** The paramset keys known for a channel. */
  public getParamsetKeys(interfaceId: string, channelAddress: string): string[] {
    const forChannel = this.byInterface.get(interfaceId)?.get(channelAddress);
    return forChannel === undefined ? [] : [...forChannel.keys()];
  }

  /**
   * Remove all paramsets for a device: the channel equal to `address` (its
   * own MASTER paramset) and every channel `address:*`.
   */
  public removeDevice(interfaceId: string, address: string): void {
    const forIface = this.byInterface.get(interfaceId);
    if (forIface === undefined) return;
    const channelPrefix = `${address}:`;
    for (const channelAddress of [...forIface.keys()]) {
      if (channelAddress === address || channelAddress.startsWith(channelPrefix)) {
        forIface.delete(channelAddress);
      }
    }
  }

  protected toData(): ParamsetData {
    const data: ParamsetData = {};
    for (const [iface, forIface] of this.byInterface) {
      const channels: Record<string, Record<string, Paramset>> = {};
      for (const [channelAddress, forChannel] of forIface) {
        const paramsets: Record<string, Paramset> = {};
        for (const [paramsetKey, paramset] of forChannel) {
          paramsets[paramsetKey] = paramset;
        }
        channels[channelAddress] = paramsets;
      }
      data[iface] = channels;
    }
    return data;
  }

  protected fromData(data: unknown): void {
    const next = new Map<string, Map<string, Map<string, Paramset>>>();
    const record = (data ?? {}) as ParamsetData;
    for (const [iface, channels] of Object.entries(record)) {
      const forIface = new Map<string, Map<string, Paramset>>();
      for (const [channelAddress, paramsets] of Object.entries(channels)) {
        const forChannel = new Map<string, Paramset>();
        for (const [paramsetKey, paramset] of Object.entries(paramsets)) {
          forChannel.set(paramsetKey, paramset);
        }
        forIface.set(channelAddress, forChannel);
      }
      next.set(iface, forIface);
    }
    this.byInterface = next;
  }

  protected resetData(): void {
    this.byInterface = new Map<string, Map<string, Map<string, Paramset>>>();
  }
}
