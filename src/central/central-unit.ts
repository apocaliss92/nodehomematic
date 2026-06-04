/**
 * {@link CentralUnit} — the internal facade that orchestrates the Phase 1
 * transport (one {@link InterfaceClient} per interface + a shared
 * {@link CallbackServer} + JSON-RPC session) into a typed device graph and a
 * rock-solid reconnection loop.
 *
 * Responsibilities:
 *  - lifecycle: {@link CentralUnit.start} / {@link CentralUnit.stop};
 *  - cache loading + warm start (rebuild the graph from disk without RPC);
 *  - discovery (paramset descriptions + JSON-RPC name/room merge);
 *  - wiring CCU callbacks → value cache + typed {@link EventBus};
 *  - connection health: per-interface ping/pong, callback liveness, periodic
 *    connection-check, and staged {@link ConnectionRecovery} on loss;
 *  - the Phase 3 read surface: {@link CentralUnit.registry},
 *    {@link CentralUnit.eventBus}, {@link CentralUnit.getValue},
 *    {@link CentralUnit.setValue}, {@link CentralUnit.devices}.
 *
 * NO domain model lives here (that is Phase 3): the graph is raw typed data.
 */

import { connect, type Socket } from 'node:net';
import { Interface, INTERFACE_PORTS, ParamsetKey } from '../support/constants.js';
import type { DataPointKey } from '../support/dpk.js';
import { ClientState } from '../transport/resilience/state-machine.js';
import { InterfaceClient } from '../transport/interface-client.js';
import { JsonRpcClient } from '../transport/jsonrpc/client.js';
import { SessionManager } from '../transport/jsonrpc/session.js';
import { CallbackServer } from '../transport/callback-server/server.js';
import type { RawCallbackEvent } from '../transport/callback-server/events.js';
import type { XmlRpcValue } from '../transport/xmlrpc/types.js';
import { EventBus } from './event-bus.js';
import { DeviceRegistry } from './device-registry.js';
import {
  DeviceDescriptionCache,
  ParamsetDescriptionCache,
  type LoadResult,
} from './store/description-cache.js';
import { ValueCache } from './store/value-cache.js';
import {
  FileStorageBackend,
  InMemoryStorageBackend,
  type StorageBackend,
} from './store/storage-backend.js';
import { discoverInterface, mergeDetails, warmStart, type DeviceDetails } from './discovery.js';
import type { DeviceNode } from './graph.js';
import { ConnectionStateTracker } from './connection/connection-state.js';
import { PingPongTracker } from './connection/ping-pong.js';
import { ConnectionRecovery, type RecoveryHooks } from './connection/recovery.js';
import { Scheduler } from './connection/scheduler.js';
import { CallbackRouter } from './callback-router.js';

/** Minimal JSON-RPC client surface the central depends on (injectable for tests). */
export interface JsonRpcClientLike {
  post(
    method: string,
    params?: Record<string, unknown>,
    opts?: { readonly sessionId?: string },
  ): Promise<unknown>;
  close(): Promise<void>;
}

/** WebUI credentials for JSON-RPC name/room metadata. */
export interface CentralCredentials {
  readonly username: string;
  readonly password: string;
}

/** Local callback server binding. */
export interface CallbackConfig {
  readonly host: string;
  readonly port: number;
}

/** Cache directory / toggle. */
export interface CacheConfig {
  readonly dir?: string;
  readonly enabled?: boolean;
}

/** Tunable scheduler/recovery intervals (defaults match the prod plan). */
export interface CentralTimings {
  /** Connection-check cadence in ms (prod: 15000). */
  readonly connectionCheckMs?: number;
  /** Periodic value-refresh cadence in ms (prod: 15000). */
  readonly valueRefreshMs?: number;
}

/** Construction options for {@link CentralUnit}. */
export interface CentralUnitOptions {
  readonly centralName: string;
  readonly host: string;
  readonly interfaces: Interface[];
  readonly credentials?: CentralCredentials;
  readonly callback: CallbackConfig;
  readonly cache?: CacheConfig;
  readonly storageBackend?: StorageBackend;
  readonly tls?: boolean;
  readonly timings?: CentralTimings;
  /**
   * Override the TCP port per interface (some deployments expose the XML-RPC
   * endpoint on a non-standard port). Falls back to {@link INTERFACE_PORTS}.
   */
  readonly interfacePorts?: Partial<Record<Interface, number>>;

  // --- injectables (tests) ---
  /** Build an {@link InterfaceClient} for an interface (defaults to a real one). */
  readonly makeInterfaceClient?: (iface: Interface) => InterfaceClient;
  /** Inject a JSON-RPC client (defaults to a real {@link JsonRpcClient}). */
  readonly jsonClient?: JsonRpcClientLike;
  /** Injectable clock. */
  readonly now?: () => number;
  /** Injectable recovery sleep (tests pass a near-immediate stub). */
  readonly recoverySleep?: (ms: number) => Promise<void>;
  /**
   * Injectable TCP reachability probe for an interface id (defaults to opening a
   * real socket to host:interfacePort). Tests inject one targeting the fake
   * CCU's ephemeral port.
   */
  readonly tcpProbe?: (interfaceId: string) => Promise<boolean>;
}

const DEFAULT_CONNECTION_CHECK_MS = 15_000;
const DEFAULT_VALUE_REFRESH_MS = 15_000;
const CONNECTION_CHECK_JOB = 'connection-check';
const VALUE_REFRESH_JOB = 'value-refresh';
const TCP_CHECK_TIMEOUT_MS = 2_000;

const DEVICE_CACHE_FILE = 'device_descriptions';
const PARAMSET_CACHE_FILE = 'paramset_descriptions';

/** Per-interface runtime bundle the central wires together. */
interface InterfaceRuntime {
  readonly iface: Interface;
  readonly interfaceId: string;
  readonly client: InterfaceClient;
  readonly pingPong: PingPongTracker;
  /** Monotonic counter producing unique ping tokens. */
  pingSeq: number;
}

export class CentralUnit {
  private readonly centralName: string;
  private readonly host: string;
  private readonly interfaces: Interface[];
  private readonly credentials: CentralCredentials | undefined;
  private readonly callbackConfig: CallbackConfig;
  private readonly cacheEnabled: boolean;
  private readonly tls: boolean;
  private readonly now: () => number;
  private readonly connectionCheckMs: number;
  private readonly valueRefreshMs: number;
  private readonly recoverySleep: (ms: number) => Promise<void>;
  private readonly tcpProbe: (interfaceId: string) => Promise<boolean>;

  private readonly makeInterfaceClientFn: (iface: Interface) => InterfaceClient;

  private readonly storageBackend: StorageBackend;
  private readonly deviceCache: DeviceDescriptionCache;
  private readonly paramsetCache: ParamsetDescriptionCache;
  private readonly valueCache = new ValueCache();
  private readonly registryStore = new DeviceRegistry();
  private readonly bus = new EventBus();
  private readonly connectionState: ConnectionStateTracker;
  private readonly scheduler = new Scheduler();

  private readonly runtimes = new Map<string, InterfaceRuntime>();
  private readonly ifaceById = new Map<string, Interface>();
  private jsonClient: JsonRpcClientLike | undefined;
  private session: SessionManager | undefined;
  private callbackServer: CallbackServer | undefined;
  private router: CallbackRouter | undefined;
  private recovery: ConnectionRecovery | undefined;
  private details: DeviceDetails | undefined;
  private warmStarted = false;
  private started = false;

  public constructor(private readonly options: CentralUnitOptions) {
    this.centralName = options.centralName;
    this.host = options.host;
    this.interfaces = [...options.interfaces];
    this.credentials = options.credentials;
    this.callbackConfig = options.callback;
    this.cacheEnabled = options.cache?.enabled ?? true;
    this.tls = options.tls ?? false;
    this.now = options.now ?? Date.now;
    this.connectionCheckMs = options.timings?.connectionCheckMs ?? DEFAULT_CONNECTION_CHECK_MS;
    this.valueRefreshMs = options.timings?.valueRefreshMs ?? DEFAULT_VALUE_REFRESH_MS;
    this.recoverySleep = options.recoverySleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tcpProbe = options.tcpProbe ?? ((id) => this.defaultTcpCheck(id));
    this.makeInterfaceClientFn =
      options.makeInterfaceClient ?? ((iface) => this.buildRealInterfaceClient(iface));

    this.storageBackend = options.storageBackend ?? this.buildDefaultStorageBackend();
    this.deviceCache = new DeviceDescriptionCache(this.storageBackend, DEVICE_CACHE_FILE);
    this.paramsetCache = new ParamsetDescriptionCache(this.storageBackend, PARAMSET_CACHE_FILE);
    this.connectionState = new ConnectionStateTracker({ eventBus: this.bus, now: this.now });
  }

  // --- public read surface (Phase 3) ---------------------------------------

  /** The immutable device registry. */
  public get registry(): DeviceRegistry {
    return this.registryStore;
  }

  /** The typed event bus. */
  public get eventBus(): EventBus {
    return this.bus;
  }

  /** A snapshot of all known devices. */
  public devices(): DeviceNode[] {
    return this.registryStore.getAll();
  }

  /** The bound callback-server port (0 until {@link start} binds it). */
  public get callbackPort(): number {
    return this.callbackServer?.port ?? this.callbackConfig.port;
  }

  /** Latest cached value for a data point, or `undefined`. */
  public getValue(dpk: DataPointKey): unknown {
    return this.valueCache.get(dpk)?.value;
  }

  /**
   * Write a value back to the CCU. VALUES paramset routes to `setValue`; MASTER
   * routes to a single-parameter `putParamset`. Throws if the dpk's interface is
   * unknown.
   */
  public async setValue(dpk: DataPointKey, value: XmlRpcValue): Promise<void> {
    const runtime = this.runtimes.get(dpk.interfaceId);
    if (runtime === undefined) {
      throw new Error(`setValue: unknown interface "${dpk.interfaceId}"`);
    }
    if (dpk.paramsetKey === (ParamsetKey.MASTER as string)) {
      await runtime.client.putParamset(dpk.channelAddress, ParamsetKey.MASTER, {
        [dpk.parameter]: value,
      });
      return;
    }
    await runtime.client.setValue(dpk.channelAddress, dpk.parameter, value);
  }

  // --- lifecycle ------------------------------------------------------------

  /** Start the central: load caches, init proxies, discover, schedule, ready. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const cacheLoaded = await this.loadCaches();
    this.warmStarted = this.cacheEnabled && cacheLoaded;

    this.buildRuntimes();
    this.buildJsonRpc();
    await this.startCallbackServer();
    this.buildRecovery();
    this.buildRouter();

    for (const runtime of this.runtimes.values()) {
      await runtime.client.initProxy();
      this.connectionState.setState(runtime.interfaceId, ClientState.CONNECTED);
    }

    if (this.warmStarted) {
      this.rebuildFromCache();
    } else {
      await this.runFullDiscovery();
    }

    this.registerSchedulerJobs();
    this.scheduler.start();

    await this.bus.publish({ type: 'ready' });
  }

  /** Stop the central: persist caches, tear down transport + server + session. */
  public async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    this.scheduler.stop();
    this.recovery?.stop();

    await this.saveCaches();

    for (const runtime of this.runtimes.values()) {
      try {
        await runtime.client.deinitProxy();
      } catch {
        // best-effort teardown
      }
      this.connectionState.setState(runtime.interfaceId, ClientState.DISCONNECTED);
    }

    if (this.session !== undefined) {
      try {
        await this.session.logout();
      } catch {
        // best-effort logout
      }
    }
    if (this.jsonClient !== undefined) {
      await this.jsonClient.close();
    }
    if (this.callbackServer !== undefined) {
      await this.callbackServer.stop();
    }
    this.bus.clear();
  }

  // --- construction helpers -------------------------------------------------

  private buildDefaultStorageBackend(): StorageBackend {
    const dir = this.options.cache?.dir;
    if (!this.cacheEnabled || dir === undefined) {
      return new InMemoryStorageBackend();
    }
    return new FileStorageBackend({ dir, centralName: this.centralName });
  }

  /** Resolve the XML-RPC port for an interface (override → TLS/plain default). */
  private portFor(iface: Interface): number {
    const override = this.options.interfacePorts?.[iface];
    if (override !== undefined) return override;
    return this.tls ? INTERFACE_PORTS[iface].tls : INTERFACE_PORTS[iface].nonTls;
  }

  private buildRealInterfaceClient(iface: Interface): InterfaceClient {
    const auth =
      this.credentials === undefined
        ? undefined
        : { username: this.credentials.username, password: this.credentials.password };
    const tls = this.tls;
    const port = this.portFor(iface);
    return new InterfaceClient({
      centralName: this.centralName,
      interface: iface,
      host: this.host,
      port,
      tls,
      ...(auth !== undefined ? { auth } : {}),
      callbackUrlProvider: () => this.callbackUrl(),
    });
  }

  private callbackUrl(): string {
    const port = this.callbackServer?.port ?? this.callbackConfig.port;
    return `http://${this.callbackConfig.host}:${port}`;
  }

  private buildRuntimes(): void {
    for (const iface of this.interfaces) {
      const client = this.makeInterfaceClientFn(iface);
      const interfaceId = client.interfaceId;
      const pingPong = new PingPongTracker({ now: this.now });
      this.runtimes.set(interfaceId, { iface, interfaceId, client, pingPong, pingSeq: 0 });
      this.ifaceById.set(interfaceId, iface);
    }
  }

  private buildJsonRpc(): void {
    if (this.credentials === undefined) return;
    if (this.options.jsonClient !== undefined) {
      this.jsonClient = this.options.jsonClient;
    } else {
      const scheme = this.tls ? 'https' : 'http';
      const client = new JsonRpcClient({ url: `${scheme}://${this.host}` });
      this.jsonClient = client;
      this.session = new SessionManager({
        client,
        username: this.credentials.username,
        password: this.credentials.password,
      });
    }
  }

  private async startCallbackServer(): Promise<void> {
    this.callbackServer = new CallbackServer({
      host: this.callbackConfig.host,
      port: this.callbackConfig.port,
      onEvent: (event: RawCallbackEvent): void => {
        // The HTTP handler is sync; routing is fire-and-forget with the bus's
        // own error isolation handling any rejection downstream.
        void this.routeEvent(event);
      },
    });
    await this.callbackServer.start();
  }

  private buildRouter(): void {
    this.router = new CallbackRouter({
      eventBus: this.bus,
      valueCache: this.valueCache,
      registry: this.registryStore,
      connectionState: this.connectionState,
      pingPongFor: (id) => this.runtimes.get(id)?.pingPong,
      now: this.now,
      hooks: {
        onNewDevices: (id, addresses) => this.discoverAddresses(id, addresses, true),
        onUpdateDevice: (id, address) => this.reDiscoverDevice(id, address),
        onReaddDevices: (id, addresses) => this.discoverAddresses(id, addresses, true),
      },
    });
  }

  private buildRecovery(): void {
    const hooks: RecoveryHooks = {
      tcpCheck: (id) => this.tcpCheck(id),
      rpcCheck: (id) => this.rpcCheck(id),
      doReconnect: (id) => this.doReconnect(id),
      reloadData: (id) => this.reloadData(id),
      hasExistingClient: (id) => this.runtimes.has(id),
    };
    this.recovery = new ConnectionRecovery({
      eventBus: this.bus,
      sleep: this.recoverySleep,
      now: this.now,
      hooks,
    });
  }

  private async routeEvent(event: RawCallbackEvent): Promise<void> {
    if (this.router === undefined) return;
    try {
      await this.router.route(event);
    } catch {
      // Router/discovery errors are isolated; a bad push must not crash the
      // server. The connection-check loop will surface persistent problems.
    }
  }

  // --- caches ---------------------------------------------------------------

  /** Load both caches; returns true if a non-empty warm start is possible. */
  private async loadCaches(): Promise<boolean> {
    if (!this.cacheEnabled) return false;
    const deviceResult = await this.deviceCache.load();
    const paramsetResult = await this.paramsetCache.load();
    return this.canWarmStart(deviceResult, paramsetResult);
  }

  private canWarmStart(deviceResult: LoadResult, paramsetResult: LoadResult): boolean {
    if (deviceResult !== 'loaded' || paramsetResult !== 'loaded') return false;
    // Non-empty: at least one interface has cached descriptions.
    return this.deviceCache.getAllInterfaces().length > 0;
  }

  private async saveCaches(): Promise<void> {
    if (!this.cacheEnabled) return;
    await this.deviceCache.saveIfChanged();
    await this.paramsetCache.saveIfChanged();
  }

  // --- discovery ------------------------------------------------------------

  /** Warm path: rebuild devices from the loaded caches without any RPC. */
  private rebuildFromCache(): void {
    for (const runtime of this.runtimes.values()) {
      const nodes = warmStart({
        interfaceId: runtime.interfaceId,
        deviceCache: this.deviceCache,
        paramsetCache: this.paramsetCache,
      });
      this.upsertNodes(nodes);
      void this.publishCreated(nodes);
    }
  }

  /** Cold path: run full discovery (paramsets + JSON-RPC details) per interface. */
  private async runFullDiscovery(): Promise<void> {
    this.details = await this.fetchDetails();
    for (const runtime of this.runtimes.values()) {
      const nodes = await discoverInterface({
        source: runtime.client,
        deviceCache: this.deviceCache,
        paramsetCache: this.paramsetCache,
        ...(this.details !== undefined ? { details: this.details } : {}),
      });
      this.upsertNodes(nodes);
      await this.publishCreated(nodes);
    }
  }

  /** Fetch (and cache) the JSON-RPC name/room/function details, if credentialed. */
  private async fetchDetails(): Promise<DeviceDetails | undefined> {
    if (this.jsonClient === undefined) return undefined;
    try {
      const sessionId = this.session !== undefined ? await this.session.ensureSession() : undefined;
      return await mergeDetails(this.jsonClient, sessionId);
    } catch {
      // Details are best-effort metadata; discovery proceeds without them.
      return undefined;
    }
  }

  /**
   * Incrementally (re-)discover a set of device addresses on an interface. Used
   * by `newDevices` / `replaceDevice` / `readdedDevice`. Re-runs the full
   * interface discovery (idempotent: the caches dedup) and re-emits the touched
   * nodes.
   */
  private async discoverAddresses(
    interfaceId: string,
    addresses: readonly string[],
    publish: boolean,
  ): Promise<void> {
    const runtime = this.runtimes.get(interfaceId);
    if (runtime === undefined) return;
    const nodes = await discoverInterface({
      source: runtime.client,
      deviceCache: this.deviceCache,
      paramsetCache: this.paramsetCache,
      ...(this.details !== undefined ? { details: this.details } : {}),
    });
    const wanted = new Set(addresses.map((a) => deviceAddressOf(a)));
    const touched = nodes.filter((node) => wanted.has(node.address));
    this.upsertNodes(touched);
    if (publish) {
      for (const node of touched) {
        await this.bus.publish({ type: 'deviceAdded', address: node.address });
      }
      await this.publishCreated(touched);
    }
  }

  /** Re-discover a single device after an `updateDevice` hint. */
  private async reDiscoverDevice(interfaceId: string, address: string): Promise<void> {
    const deviceAddress = deviceAddressOf(address);
    this.deviceCache.removeDevice(interfaceId, deviceAddress);
    this.paramsetCache.removeDevice(interfaceId, deviceAddress);
    await this.discoverAddresses(interfaceId, [deviceAddress], false);
  }

  private upsertNodes(nodes: readonly DeviceNode[]): void {
    for (const node of nodes) {
      this.registryStore.upsert(node);
    }
  }

  private async publishCreated(nodes: readonly DeviceNode[]): Promise<void> {
    if (nodes.length === 0) return;
    await this.bus.publish({ type: 'devicesCreated', addresses: nodes.map((n) => n.address) });
  }

  // --- scheduler / health ---------------------------------------------------

  private registerSchedulerJobs(): void {
    this.scheduler.add({
      name: CONNECTION_CHECK_JOB,
      intervalMs: this.connectionCheckMs,
      run: () => this.connectionCheck(),
    });
    this.scheduler.add({
      name: VALUE_REFRESH_JOB,
      intervalMs: this.valueRefreshMs,
      run: () => Promise.resolve(),
    });
  }

  /**
   * One connection-check pass: ping each interface (recording the token) and
   * verify callback liveness; on a detected loss, trigger recovery and suspend
   * the other scheduler jobs until recovery completes.
   */
  public async connectionCheck(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      const lost = await this.probeInterface(runtime);
      if (lost) {
        await this.triggerRecovery(runtime.interfaceId);
      }
    }
  }

  /** Ping + liveness probe for one interface. Returns true on a detected loss. */
  private async probeInterface(runtime: InterfaceRuntime): Promise<boolean> {
    const token = `${runtime.pingSeq++}`;
    runtime.pingPong.handleSendPing(token);
    let pingOk = false;
    try {
      pingOk = await runtime.client.ping(`${runtime.interfaceId}#${token}`);
    } catch {
      pingOk = false;
    }
    const callbackAlive = this.connectionState.isCallbackAlive(runtime.interfaceId);
    return !pingOk || !callbackAlive || runtime.pingPong.isMismatch();
  }

  private async triggerRecovery(interfaceId: string): Promise<void> {
    if (this.recovery === undefined) return;
    this.scheduler.pauseAllExcept(CONNECTION_CHECK_JOB);
    this.connectionState.setState(interfaceId, ClientState.RECONNECTING, 'loss detected');
    const recovered = await this.recovery.recover(interfaceId);
    if (recovered) {
      this.connectionState.setState(interfaceId, ClientState.CONNECTED, 'recovered');
      this.scheduler.resume();
    } else {
      this.connectionState.setState(interfaceId, ClientState.FAILED, 'recovery failed');
    }
  }

  // --- recovery hooks -------------------------------------------------------

  private tcpCheck(interfaceId: string): Promise<boolean> {
    return this.tcpProbe(interfaceId);
  }

  private defaultTcpCheck(interfaceId: string): Promise<boolean> {
    const iface = this.ifaceById.get(interfaceId);
    if (iface === undefined) return Promise.resolve(false);
    return this.openTcp(this.host, this.portFor(iface), TCP_CHECK_TIMEOUT_MS);
  }

  /** Open a TCP socket to host:port; resolves true on connect, false otherwise. */
  private openTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean, socket?: Socket): void => {
        if (settled) return;
        settled = true;
        socket?.destroy();
        resolve(ok);
      };
      const socket = connect({ host, port }, () => finish(true, socket));
      socket.setTimeout(timeoutMs, () => finish(false, socket));
      socket.once('error', () => finish(false, socket));
    });
  }

  private async rpcCheck(interfaceId: string): Promise<boolean> {
    const runtime = this.runtimes.get(interfaceId);
    if (runtime === undefined) return false;
    try {
      const methods = await runtime.client.listMethods();
      return methods.length > 0;
    } catch {
      try {
        await runtime.client.getVersion();
        return true;
      } catch {
        return false;
      }
    }
  }

  private async doReconnect(interfaceId: string): Promise<void> {
    const runtime = this.runtimes.get(interfaceId);
    if (runtime === undefined) return;
    try {
      await runtime.client.deinitProxy();
    } catch {
      // ignore: deinit may fail if the CCU forgot us; init below re-establishes.
    }
    await runtime.client.initProxy();
    runtime.pingPong.reset();
  }

  private async reloadData(interfaceId: string): Promise<void> {
    // Re-sync values only (descriptions stay in cache). Best-effort: re-fetch
    // the latest value for each known data point on this interface so the value
    // cache is fresh after a reconnect.
    const runtime = this.runtimes.get(interfaceId);
    if (runtime === undefined) return;
    for (const node of this.registryStore.getAll()) {
      if (node.interfaceId !== interfaceId) continue;
      for (const channel of node.channels) {
        const valuesParams = channel.parameters;
        for (const [parameter, specs] of valuesParams) {
          if (specs.VALUES === undefined || !specs.VALUES.readable) continue;
          try {
            const value = (await runtime.client.getValue(
              channel.address,
              parameter,
            )) as XmlRpcValue;
            const dpk = makeDpkValues(interfaceId, channel.address, parameter);
            this.valueCache.add(dpk, value, this.now());
          } catch {
            // skip unreadable / transient failures during re-sync
          }
        }
      }
    }
  }
}

/** Address of the device owning a channel address (`DEV:idx` → `DEV`). */
function deviceAddressOf(channelAddress: string): string {
  const colon = channelAddress.lastIndexOf(':');
  return colon === -1 ? channelAddress : channelAddress.slice(0, colon);
}

/** Build a VALUES dpk (used during value re-sync). */
function makeDpkValues(
  interfaceId: string,
  channelAddress: string,
  parameter: string,
): DataPointKey {
  return { interfaceId, channelAddress, paramsetKey: ParamsetKey.VALUES, parameter };
}
