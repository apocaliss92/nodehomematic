/**
 * Composes the transport primitives for a SINGLE CCU interface (e.g. HmIP-RF):
 * an XML-RPC client, a circuit breaker, retry, request coalescing and the
 * connection state machine. It exposes the raw CCU methods with typed
 * signatures (positional argument order matters and mirrors the protocol).
 *
 * The transport layer carries NO domain logic — it speaks raw CCU methods and
 * returns the parsed values, casting them to the declared transport shapes at
 * the documented trust boundary.
 */

import { CircuitBreakerOpenError, NoConnectionError, TimeoutError } from '../support/errors.js';
import {
  Interface,
  INTERFACE_PORTS,
  interfaceId as buildInterfaceId,
  TIMEOUTS,
} from '../support/constants.js';
import { CircuitBreaker } from './resilience/circuit-breaker.js';
import { withRetry, defaultGetFaultCode, type RetryOptions } from './resilience/retry.js';
import { RequestCoalescer, makeKey } from './resilience/coalescer.js';
import {
  ConnectionStateMachine,
  ClientState,
  type StateChangeEvent,
} from './resilience/state-machine.js';
import { XmlRpcClient, type BasicAuth } from './xmlrpc/client.js';
import type { DeviceDescription, ParameterData, ParamsetKey, XmlRpcValue } from './xmlrpc/types.js';

/**
 * Minimal contract the {@link InterfaceClient} needs from an XML-RPC client.
 * {@link XmlRpcClient} implements it; tests can inject a fake.
 */
export interface XmlRpcClientLike {
  call(method: string, params: readonly XmlRpcValue[]): Promise<XmlRpcValue>;
}

/** Factory used to build the underlying XML-RPC client (overridable in tests). */
export type XmlRpcClientFactory = (
  url: string,
  auth: BasicAuth | undefined,
  tls: boolean,
) => XmlRpcClientLike;

/** Construction options for {@link InterfaceClient}. */
export interface InterfaceClientOptions {
  /** Logical name of the central (used to build the interface id). */
  readonly centralName: string;
  /** Which CCU interface this client talks to. */
  readonly interface: Interface;
  /** CCU host name or IP. */
  readonly host: string;
  /** Override the port; defaults to the interface's plain/TLS port. */
  readonly port?: number;
  /**
   * Optional XML-RPC remote URL path (e.g. `'/groups'` for VirtualDevices).
   * Appended to `{scheme}://{host}:{port}`. Defaults to the server root (`/`)
   * when omitted. The callback URL is unaffected by this.
   */
  readonly path?: string;
  /** Use HTTPS for the XML-RPC endpoint. */
  readonly tls?: boolean;
  /** Optional HTTP Basic auth credentials. */
  readonly auth?: BasicAuth;
  /** Returns the `http://host:port` callback URL to (de)register. */
  readonly callbackUrlProvider: () => string;
  /** Shared/injected breaker; defaults to a fresh {@link CircuitBreaker}. */
  readonly circuitBreaker?: CircuitBreaker;
  /** Overrides for the write-command retry policy. */
  readonly retryOptions?: Partial<RetryOptions>;
  /** Per-request timeout in ms; defaults to {@link TIMEOUTS.rpc}. */
  readonly timeoutMs?: number;
  /** Injectable XML-RPC client factory (for tests). */
  readonly makeClient?: XmlRpcClientFactory;
}

/**
 * Methods that bypass the circuit breaker entirely (mirrors aiohomematic): they
 * are lifecycle/probe calls and must work even when the breaker is OPEN. No
 * success/failure is recorded for them.
 */
const BYPASS_METHODS = new Set<string>([
  'init',
  'ping',
  'system.listMethods',
  'getVersion',
  'clientServerInitialized',
]);

interface CallGuardOptions {
  readonly bypassBreaker?: boolean;
}

// `tls` is encoded in the URL scheme already, so the default factory ignores it.
const defaultMakeClient: XmlRpcClientFactory = (
  url: string,
  auth: BasicAuth | undefined,
): XmlRpcClientLike => {
  const options =
    auth === undefined ? { url, timeoutMs: TIMEOUTS.rpc } : { url, auth, timeoutMs: TIMEOUTS.rpc };
  return new XmlRpcClient(options);
};

export class InterfaceClient {
  private readonly centralName: string;
  private readonly iface: Interface;
  private readonly callbackUrlProvider: () => string;
  private readonly breaker: CircuitBreaker;
  private readonly retryOptions: Partial<RetryOptions>;
  private readonly coalescer = new RequestCoalescer();
  private readonly machine = new ConnectionStateMachine(ClientState.CREATED);
  // Phase 1 simplification: aiohomematic uses two proxies (one for reads, one
  // for writes) to avoid head-of-line blocking. A single client instance is
  // acceptable here; the split can be introduced later behind this same API.
  private readonly client: XmlRpcClientLike;

  public constructor(options: InterfaceClientOptions) {
    this.centralName = options.centralName;
    this.iface = options.interface;
    this.callbackUrlProvider = options.callbackUrlProvider;
    this.breaker = options.circuitBreaker ?? new CircuitBreaker();
    this.retryOptions = options.retryOptions ?? {};

    const tls = options.tls ?? false;
    const ports = INTERFACE_PORTS[options.interface];
    const port = options.port ?? (tls ? ports.tls : ports.nonTls);
    const scheme = tls ? 'https' : 'http';
    // Most interfaces serve XML-RPC at the root; VirtualDevices uses `/groups`.
    const path = options.path ?? '/';
    const url = `${scheme}://${options.host}:${port}${path}`;
    const makeClient = options.makeClient ?? defaultMakeClient;
    this.client = makeClient(url, options.auth, tls);
  }

  /** Interface id used to register the callback proxy: `{centralName}-{interface}`. */
  public get interfaceId(): string {
    return buildInterfaceId(this.centralName, this.iface);
  }

  /** Current connection lifecycle state. */
  public get state(): ClientState {
    return this.machine.state;
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
  public onStateChange(cb: (event: StateChangeEvent) => void): () => void {
    return this.machine.onChange(cb);
  }

  /**
   * Register the callback proxy with the CCU: `init(callbackUrl, interfaceId)`.
   * Drives the state machine through the valid path to CONNECTED, or to FAILED
   * on error.
   */
  public async initProxy(): Promise<void> {
    this.markInitializing();
    this.machine.transitionTo(ClientState.CONNECTING, 'initProxy');
    try {
      await this.callGuarded('init', [this.callbackUrlProvider(), this.interfaceId], {
        bypassBreaker: true,
      });
      this.machine.transitionTo(ClientState.CONNECTED, 'initProxy ok');
    } catch (err) {
      this.machine.transitionTo(ClientState.FAILED, 'initProxy failed');
      throw err;
    }
  }

  /**
   * De-register the callback proxy: `init(callbackUrl)` (SINGLE argument).
   * Drives the state machine toward DISCONNECTED.
   */
  public async deinitProxy(): Promise<void> {
    try {
      await this.callGuarded('init', [this.callbackUrlProvider()], { bypassBreaker: true });
    } finally {
      this.markDisconnected('deinitProxy');
    }
  }

  /** Liveness probe: `ping(callerId)` → bool. */
  public async ping(callerId?: string): Promise<boolean> {
    const result = await this.callGuarded('ping', [callerId ?? this.interfaceId], {
      bypassBreaker: true,
    });
    return result === true;
  }

  /** `listDevices()` → device descriptions. */
  public async listDevices(): Promise<DeviceDescription[]> {
    const result = await this.callGuarded('listDevices', []);
    return asDeviceDescriptionArray(result);
  }

  /** `getDeviceDescription(address)` (coalesced). */
  public async getDeviceDescription(address: string): Promise<DeviceDescription> {
    const key = makeKey('getDeviceDescription', [address]);
    return this.coalescer.coalesce(key, async () => {
      const result = await this.callGuarded('getDeviceDescription', [address]);
      return asDeviceDescription(result);
    });
  }

  /** `getParamsetDescription(channelAddress, paramsetKey)` (coalesced). */
  public async getParamsetDescription(
    channelAddress: string,
    paramsetKey: ParamsetKey,
  ): Promise<Record<string, ParameterData>> {
    const key = makeKey('getParamsetDescription', [channelAddress, paramsetKey]);
    return this.coalescer.coalesce(key, async () => {
      const result = await this.callGuarded('getParamsetDescription', [
        channelAddress,
        paramsetKey,
      ]);
      return asParamsetDescription(result);
    });
  }

  /** `getParamset(channelAddress, paramsetKey)` → struct. */
  public async getParamset(
    channelAddress: string,
    paramsetKey: ParamsetKey,
  ): Promise<Record<string, unknown>> {
    const result = await this.callGuarded('getParamset', [channelAddress, paramsetKey]);
    return asStruct(result);
  }

  /** `getValue(channelAddress, parameter)` → any. */
  public async getValue(channelAddress: string, parameter: string): Promise<unknown> {
    return this.callGuarded('getValue', [channelAddress, parameter]);
  }

  /** `setValue(channelAddress, parameter, value[, rxMode])` — wrapped in retry. */
  public async setValue(
    channelAddress: string,
    parameter: string,
    value: XmlRpcValue,
    rxMode?: string,
  ): Promise<void> {
    const params: XmlRpcValue[] =
      rxMode === undefined
        ? [channelAddress, parameter, value]
        : [channelAddress, parameter, value, rxMode];
    await withRetry(() => this.callGuarded('setValue', params), {
      getFaultCode: defaultGetFaultCode,
      ...this.retryOptions,
    });
  }

  /** `putParamset(channelAddress, paramsetKey, values[, rxMode])` — wrapped in retry. */
  public async putParamset(
    channelAddress: string,
    paramsetKey: ParamsetKey,
    values: Record<string, XmlRpcValue>,
    rxMode?: string,
  ): Promise<void> {
    const params: XmlRpcValue[] =
      rxMode === undefined
        ? [channelAddress, paramsetKey, values]
        : [channelAddress, paramsetKey, values, rxMode];
    await withRetry(() => this.callGuarded('putParamset', params), {
      getFaultCode: defaultGetFaultCode,
      ...this.retryOptions,
    });
  }

  /** `getInstallMode()` → seconds remaining. */
  public async getInstallMode(): Promise<number> {
    const result = await this.callGuarded('getInstallMode', []);
    return typeof result === 'number' ? result : 0;
  }

  /** `getVersion()` (bypass) → backend version string. */
  public async getVersion(): Promise<string> {
    const result = await this.callGuarded('getVersion', [], { bypassBreaker: true });
    return scalarToString(result);
  }

  /** `system.listMethods()` (bypass) → supported method names. */
  public async listMethods(): Promise<string[]> {
    const result = await this.callGuarded('system.listMethods', [], { bypassBreaker: true });
    return Array.isArray(result) ? result.map(scalarToString) : [];
  }

  /**
   * Invoke `method`, gating non-bypass calls behind the circuit breaker.
   * Bypass methods skip the breaker entirely (no success/failure recorded).
   */
  private async callGuarded(
    method: string,
    params: readonly XmlRpcValue[],
    options: CallGuardOptions = {},
  ): Promise<XmlRpcValue> {
    const bypass = options.bypassBreaker || BYPASS_METHODS.has(method);
    if (bypass) {
      return this.client.call(method, params);
    }

    if (!this.breaker.isAvailable()) {
      this.breaker.recordRejection();
      throw new CircuitBreakerOpenError(`circuit breaker open for ${this.interfaceId}`);
    }

    try {
      const result = await this.client.call(method, params);
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      // Only connection-type failures count against the breaker; logical faults
      // (unknown device/parameter, etc.) should not trip it open.
      if (err instanceof NoConnectionError || err instanceof TimeoutError) {
        this.breaker.recordFailure();
      }
      throw err;
    }
  }

  /** Drive the machine to INITIALIZING from any valid predecessor. */
  private markInitializing(): void {
    const state = this.machine.state;
    if (state === ClientState.CREATED || state === ClientState.FAILED) {
      this.machine.transitionTo(ClientState.INITIALIZING, 'initProxy');
      this.machine.transitionTo(ClientState.INITIALIZED, 'initProxy');
    } else if (state === ClientState.INITIALIZING) {
      this.machine.transitionTo(ClientState.INITIALIZED, 'initProxy');
    }
    // DISCONNECTED / INITIALIZED can go straight to CONNECTING.
  }

  /** Drive the machine toward DISCONNECTED from any valid predecessor. */
  private markDisconnected(reason: string): void {
    const state = this.machine.state;
    const canDisconnect =
      state === ClientState.CONNECTED ||
      state === ClientState.INITIALIZED ||
      state === ClientState.DISCONNECTED ||
      state === ClientState.RECONNECTING;
    if (canDisconnect) {
      this.machine.transitionTo(ClientState.DISCONNECTED, reason);
    }
  }
}

/**
 * The functions below cross the transport trust boundary: the XML-RPC parser
 * returns structurally-typed `XmlRpcValue`s, which we narrow to the declared
 * Homematic shapes. We do a minimal runtime shape check and then trust the CCU
 * for the remaining permissive fields (the model layer refines them later).
 */

/** Coerce a scalar XML-RPC value to a string, rejecting struct/array shapes. */
function scalarToString(value: XmlRpcValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
  throw new NoConnectionError('expected a scalar XML-RPC string value');
}

function isStruct(value: XmlRpcValue): value is { [key: string]: XmlRpcValue } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}

function asStruct(value: XmlRpcValue): Record<string, XmlRpcValue> {
  if (!isStruct(value)) {
    throw new NoConnectionError('expected an XML-RPC struct response');
  }
  return value;
}

function asDeviceDescription(value: XmlRpcValue): DeviceDescription {
  const struct = asStruct(value);
  return struct as DeviceDescription;
}

function asDeviceDescriptionArray(value: XmlRpcValue): DeviceDescription[] {
  if (!Array.isArray(value)) {
    throw new NoConnectionError('expected an XML-RPC array of device descriptions');
  }
  return value.map(asDeviceDescription);
}

function asParamsetDescription(value: XmlRpcValue): Record<string, ParameterData> {
  const struct = asStruct(value);
  return struct as Record<string, ParameterData>;
}
