/**
 * Minimal in-process fake CCU for integration testing the transport layer.
 *
 * It speaks two protocols over a single `node:http` server bound to an
 * ephemeral port:
 *   - XML-RPC at `/`  — the interface endpoint the {@link XmlRpcClient} talks to
 *     (init/ping/listDevices/getDeviceDescription/getValue/setValue/...).
 *   - JSON-RPC at `/api/homematic.cgi` — the CCU WebUI endpoint the
 *     {@link JsonRpcClient} talks to (Session.login/Device.listAllDetail/...).
 *
 * It uses the REAL serializer/parser so the wire format is exercised end to
 * end. State (registered callback URL, stored values) is held in memory and is
 * inspectable by the test. It can also push an `event(...)` back to the
 * registered callback URL via {@link FakeCcu.emitEvent}, simulating a CCU push.
 *
 * Test support code: lives under `tests/`, so the ESLint type-checked rules are
 * relaxed — but it is still written cleanly and fully typed.
 */
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseXmlRpc } from '../../../src/transport/xmlrpc/parse.js';
import {
  serializeFault,
  serializeMethodCall,
  serializeMethodResponse,
} from '../../../src/transport/xmlrpc/serialize.js';
import type {
  DeviceDescription,
  ParameterData,
  XmlRpcValue,
} from '../../../src/transport/xmlrpc/types.js';

/** A JSON-RPC error envelope field. */
interface JsonRpcError {
  readonly code: number;
  readonly message: string;
}

/** Construction options for {@link FakeCcu}. */
export interface FakeCcuOptions {
  /** Expected WebUI username for `Session.login`. Defaults to `'Admin'`. */
  readonly username?: string;
  /** Expected WebUI password for `Session.login`. Defaults to `'secret'`. */
  readonly password?: string;
  /**
   * Extra device descriptions appended to the canned set for this instance.
   * Lets a test advertise additional devices (e.g. a switch that maps to a
   * custom entity) WITHOUT changing the canned defaults other tests rely on.
   */
  readonly extraDevices?: readonly DeviceDescription[];
  /**
   * Extra paramset descriptions, keyed by `${channelAddress}|${paramsetKey}`,
   * merged on top of the canned paramsets for this instance.
   */
  readonly extraParamsets?: Readonly<Record<string, Record<string, ParameterData>>>;
}

/** Records of a callback (de)registration the fake CCU has seen. */
export interface RegistrationRecord {
  readonly callbackUrl: string;
  readonly interfaceId: string;
}

const SESSION_ID = 'SESSIONID123';

/**
 * Canned device descriptions returned by `listDevices`: one device with a
 * MAINTENANCE channel (`:0`) and a SHUTTER_CONTACT channel (`:1`) that exposes
 * VALUES, MASTER and LINK paramsets. PARENT/CHILDREN are wired so the graph
 * builder links them.
 */
const CANNED_DEVICES: readonly DeviceDescription[] = [
  {
    ADDRESS: 'VCU0000001',
    TYPE: 'HmIP-SWDO',
    FIRMWARE: '1.0.0',
    PARAMSETS: ['MASTER'],
    CHILDREN: ['VCU0000001:0', 'VCU0000001:1'],
  },
  {
    ADDRESS: 'VCU0000001:0',
    TYPE: 'MAINTENANCE',
    PARENT: 'VCU0000001',
    PARAMSETS: ['MASTER'],
  },
  {
    ADDRESS: 'VCU0000001:1',
    TYPE: 'SHUTTER_CONTACT',
    PARENT: 'VCU0000001',
    PARAMSETS: ['VALUES', 'MASTER', 'LINK'],
    DIRECTION: 1,
  },
];

/** Operations bitmask shortcuts (READ=1, WRITE=2, EVENT=4). */
const READ_WRITE_EVENT = 1 | 2 | 4;
const READ_EVENT = 1 | 4;
const READ_WRITE = 1 | 2;

/** Canned paramset descriptions keyed by `${channelAddress}|${paramsetKey}`. */
const CANNED_PARAMSETS: Readonly<Record<string, Record<string, ParameterData>>> = {
  'VCU0000001:1|VALUES': {
    STATE: { TYPE: 'BOOL', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1 },
    LEVEL: { TYPE: 'FLOAT', OPERATIONS: READ_EVENT, FLAGS: 1, MIN: 0, MAX: 1 },
  },
  'VCU0000001:1|MASTER': {
    CYCLIC_INFO_MSG: { TYPE: 'BOOL', OPERATIONS: READ_WRITE, FLAGS: 1 },
    CYCLIC_INFO_MSG_DIS: {
      TYPE: 'INTEGER',
      OPERATIONS: READ_WRITE,
      FLAGS: 1,
      MIN: 0,
      MAX: 100,
      DEFAULT: 28,
    },
  },
  'VCU0000001:0|MASTER': {
    DUTY_CYCLE: { TYPE: 'BOOL', OPERATIONS: 1, FLAGS: 1 },
  },
  'VCU0000001|MASTER': {},
};

/** Canned detail list returned by `Device.listAllDetail`. */
const CANNED_DEVICE_DETAIL: ReadonlyArray<Record<string, unknown>> = [
  {
    id: '4711',
    address: 'VCU0000001',
    name: 'Window Contact',
    type: 'HmIP-SWDO',
    channels: [{ address: 'VCU0000001:1', name: 'Window Contact Sensor' }],
  },
];

/** Canned room list returned by `Room.getAll`. */
const CANNED_ROOMS: ReadonlyArray<Record<string, unknown>> = [
  { id: '1234', name: 'Living Room', channelIds: ['VCU0000001:1'] },
];

/** Canned function list returned by `Subsection.getAll`. */
const CANNED_SUBSECTIONS: ReadonlyArray<Record<string, unknown>> = [
  { id: '5678', name: 'Security', channelIds: ['VCU0000001:1'] },
];

/** Supported XML-RPC method names, for `system.listMethods`. */
const XML_RPC_METHODS: readonly string[] = [
  'init',
  'ping',
  'listDevices',
  'getDeviceDescription',
  'getParamsetDescription',
  'getParamset',
  'getValue',
  'setValue',
  'putParamset',
  'getVersion',
  'system.listMethods',
];

export class FakeCcu {
  private readonly username: string;
  private readonly password: string;
  private readonly httpServer: Server;
  private boundPort = 0;

  /** Last callback (re)registration recorded via `init(url, interfaceId)`. */
  private registration: RegistrationRecord | undefined;
  /** Last de-registration recorded via single-arg `init(url)`. */
  private deregistration: string | undefined;
  /** Stored channel/parameter values, keyed by `${address}|${parameter}`. */
  private readonly values = new Map<string, XmlRpcValue>();
  /** When true, every XML-RPC request is refused (simulated outage). */
  private down = false;
  /** When true, `system.listMethods` faults (forces the getVersion fallback). */
  private listMethodsFails = false;
  /** Count of `getParamsetDescription` calls served (for warm-start assertions). */
  private paramsetFetchCount = 0;
  /** Device descriptions served by `listDevices` (canned + any extras). */
  private readonly devices: readonly DeviceDescription[];
  /** Paramset descriptions (canned + any extras), keyed `${channel}|${key}`. */
  private readonly paramsets: Readonly<Record<string, Record<string, ParameterData>>>;

  public constructor(options: FakeCcuOptions = {}) {
    this.username = options.username ?? 'Admin';
    this.password = options.password ?? 'secret';
    this.devices = [...CANNED_DEVICES, ...(options.extraDevices ?? [])];
    this.paramsets = { ...CANNED_PARAMSETS, ...(options.extraParamsets ?? {}) };
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  /** Start listening on an ephemeral port. Resolves once the socket is bound. */
  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.httpServer.removeListener('error', onError);
        reject(err);
      };
      this.httpServer.once('error', onError);
      this.httpServer.listen(0, '127.0.0.1', () => {
        this.httpServer.removeListener('error', onError);
        const address = this.httpServer.address() as AddressInfo | null;
        this.boundPort = address?.port ?? 0;
        resolve();
      });
    });
  }

  /** Stop listening and release the socket. */
  public async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** The bound TCP port (meaningful only after {@link start} resolves). */
  public get port(): number {
    return this.boundPort;
  }

  /** The XML-RPC interface base URL (root path), e.g. `http://127.0.0.1:PORT/`. */
  public get xmlRpcUrl(): string {
    return `http://127.0.0.1:${this.boundPort}/`;
  }

  /** The JSON-RPC base URL (the client appends `/api/homematic.cgi`). */
  public get jsonRpcUrl(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  /** The callback URL + interfaceId recorded by the latest `init(url, id)`, if any. */
  public get lastRegistration(): RegistrationRecord | undefined {
    return this.registration;
  }

  /** The callback URL recorded by the latest single-arg `init(url)`, if any. */
  public get lastDeregistration(): string | undefined {
    return this.deregistration;
  }

  /** Read a value previously stored via `setValue` (or `undefined`). */
  public storedValue(address: string, parameter: string): XmlRpcValue | undefined {
    return this.values.get(valueKey(address, parameter));
  }

  /**
   * Pre-seed a stored value WITHOUT a CCU push, so a subsequent `getParamset` /
   * `getValue` returns it. Used to assert the central seeds initial values at
   * start (which reads paramsets) rather than waiting for an event.
   */
  public setStoredValue(address: string, parameter: string, value: XmlRpcValue): void {
    this.values.set(valueKey(address, parameter), value);
  }

  /** Number of `getParamsetDescription` calls served so far. */
  public get paramsetFetches(): number {
    return this.paramsetFetchCount;
  }

  /**
   * Simulate a CCU outage: every XML-RPC request is refused (HTTP 500 / fault)
   * and the callback registration is dropped, until {@link restore} is called.
   */
  public dropConnection(): void {
    this.down = true;
    this.registration = undefined;
  }

  /** Resume serving XML-RPC requests after a {@link dropConnection}. */
  public restore(): void {
    this.down = false;
  }

  /** Toggle whether `system.listMethods` faults (to exercise getVersion fallback). */
  public setListMethodsFails(fails: boolean): void {
    this.listMethodsFails = fails;
  }

  /** Drop, forget the registration, then restore — simulates a CCU restart. */
  public restart(): void {
    this.dropConnection();
    this.deregistration = undefined;
    this.restore();
  }

  /**
   * Simulate a CCU push: POST an `event(interfaceId, channelAddress, parameter,
   * value)` XML-RPC methodCall to the currently registered callback URL.
   * Throws if no callback is registered.
   */
  public async emitEvent(
    channelAddress: string,
    parameter: string,
    value: XmlRpcValue,
  ): Promise<void> {
    const reg = this.registration;
    if (reg === undefined) {
      throw new Error('emitEvent called before a callback URL was registered via init()');
    }
    const body = serializeMethodCall('event', [reg.interfaceId, channelAddress, parameter, value]);
    await postTo(reg.callbackUrl, body);
  }

  /**
   * Simulate a CCU push of `newDevices(interfaceId, descriptions)` to the
   * registered callback URL. Throws if no callback is registered.
   */
  public async emitNewDevices(
    descriptions: ReadonlyArray<Record<string, XmlRpcValue>>,
  ): Promise<void> {
    const reg = this.registration;
    if (reg === undefined) {
      throw new Error('emitNewDevices called before a callback URL was registered via init()');
    }
    const body = serializeMethodCall('newDevices', [reg.interfaceId, [...descriptions]]);
    await postTo(reg.callbackUrl, body);
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '/';
      if (url.startsWith('/api/homematic.cgi')) {
        this.handleJsonRpc(body, res);
      } else {
        this.handleXmlRpc(body, res);
      }
    });
    req.on('error', () => {
      const payload = serializeFault(-1, 'request stream error');
      writeXml(res, payload);
    });
  }

  // --- XML-RPC interface endpoint -----------------------------------------

  private handleXmlRpc(body: Buffer, res: ServerResponse): void {
    if (this.down) {
      // Simulated outage: the socket still accepts (TCP up) but the RPC layer
      // is unavailable. Mirrors a CCU mid-restart.
      writeXml(res, serializeFault(-1, 'CCU unavailable'));
      return;
    }
    let methodName: string;
    let params: XmlRpcValue[];
    try {
      const parsed = parseXmlRpc(body);
      if (parsed.kind !== 'call') {
        writeXml(res, serializeFault(-1, 'expected an XML-RPC methodCall'));
        return;
      }
      methodName = parsed.call.methodName;
      params = parsed.call.params;
    } catch (err) {
      writeXml(res, serializeFault(-1, err instanceof Error ? err.message : String(err)));
      return;
    }

    try {
      const result = this.dispatchXmlRpc(methodName, params);
      writeXml(res, serializeMethodResponse(result));
    } catch (err) {
      writeXml(res, serializeFault(-1, err instanceof Error ? err.message : String(err)));
    }
  }

  private dispatchXmlRpc(method: string, params: readonly XmlRpcValue[]): XmlRpcValue {
    switch (method) {
      case 'init':
        return this.handleInit(params);
      case 'ping':
        // The CCU answers a ping with `true`; a real CCU would also push a
        // `pong` event to the callback — not needed for these tests.
        return true;
      case 'listDevices':
        return this.devices as unknown as XmlRpcValue;
      case 'getDeviceDescription':
        return this.handleGetDeviceDescription(params);
      case 'getParamsetDescription':
        return this.handleGetParamsetDescription(params);
      case 'getParamset':
        return this.handleGetParamset(params);
      case 'getValue':
        return this.handleGetValue(params);
      case 'setValue':
        return this.handleSetValue(params);
      case 'putParamset':
        return this.handlePutParamset(params);
      case 'getVersion':
        return '3.75.7';
      case 'system.listMethods':
        if (this.listMethodsFails) {
          throw new Error('listMethods unavailable');
        }
        return [...XML_RPC_METHODS];
      default:
        throw new Error(`unknown XML-RPC method: ${method}`);
    }
  }

  private handleInit(params: readonly XmlRpcValue[]): XmlRpcValue {
    const callbackUrl = asString(params[0], 'init url');
    if (params.length >= 2) {
      this.registration = { callbackUrl, interfaceId: asString(params[1], 'init interfaceId') };
    } else {
      this.deregistration = callbackUrl;
      this.registration = undefined;
    }
    // Empty string is the canonical CCU ack for init.
    return '';
  }

  private handleGetDeviceDescription(params: readonly XmlRpcValue[]): XmlRpcValue {
    const address = asString(params[0], 'getDeviceDescription address');
    const found = this.devices.find((d) => d.ADDRESS === address);
    if (found === undefined) {
      // Mirror the CCU UNKNOWN_DEVICE fault.
      throw new Error('unknown device');
    }
    return found as unknown as XmlRpcValue;
  }

  private handleGetParamsetDescription(params: readonly XmlRpcValue[]): XmlRpcValue {
    const channelAddress = asString(params[0], 'getParamsetDescription channelAddress');
    const paramsetKey = asString(params[1], 'getParamsetDescription paramsetKey');
    this.paramsetFetchCount += 1;
    const paramset = this.paramsets[`${channelAddress}|${paramsetKey}`];
    if (paramset === undefined) {
      // Unknown paramset → empty struct (defensive: discovery tolerates it).
      return {} as XmlRpcValue;
    }
    return paramset as unknown as XmlRpcValue;
  }

  /**
   * `getParamset(channelAddress, paramsetKey)` → the current values of every
   * parameter in that paramset. Returns any value stored via `putParamset`,
   * falling back to the paramset description's `DEFAULT` (or `0`).
   */
  private handleGetParamset(params: readonly XmlRpcValue[]): XmlRpcValue {
    const channelAddress = asString(params[0], 'getParamset channelAddress');
    const paramsetKey = asString(params[1], 'getParamset paramsetKey');
    const description = this.paramsets[`${channelAddress}|${paramsetKey}`] ?? {};
    const result: Record<string, XmlRpcValue> = {};
    for (const [parameter, data] of Object.entries(description)) {
      const stored = this.values.get(valueKey(channelAddress, parameter));
      result[parameter] = stored ?? data.DEFAULT ?? 0;
    }
    return result as XmlRpcValue;
  }

  private handlePutParamset(params: readonly XmlRpcValue[]): XmlRpcValue {
    const channelAddress = asString(params[0], 'putParamset channelAddress');
    const values = params[2];
    if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
      for (const [parameter, value] of Object.entries(values as Record<string, XmlRpcValue>)) {
        this.values.set(valueKey(channelAddress, parameter), value);
      }
    }
    return '';
  }

  private handleGetValue(params: readonly XmlRpcValue[]): XmlRpcValue {
    const address = asString(params[0], 'getValue address');
    const parameter = asString(params[1], 'getValue parameter');
    const stored = this.values.get(valueKey(address, parameter));
    // Default canned value when nothing has been set yet.
    return stored ?? true;
  }

  private handleSetValue(params: readonly XmlRpcValue[]): XmlRpcValue {
    const address = asString(params[0], 'setValue address');
    const parameter = asString(params[1], 'setValue parameter');
    const value = params[2] ?? null;
    this.values.set(valueKey(address, parameter), value);
    return '';
  }

  // --- JSON-RPC WebUI endpoint --------------------------------------------

  private handleJsonRpc(body: Buffer, res: ServerResponse): void {
    let method: string;
    let params: Record<string, unknown>;
    try {
      const envelope = JSON.parse(body.toString('utf-8')) as {
        method?: unknown;
        params?: unknown;
      };
      method = typeof envelope.method === 'string' ? envelope.method : '';
      params =
        envelope.params !== null && typeof envelope.params === 'object'
          ? (envelope.params as Record<string, unknown>)
          : {};
    } catch {
      writeJson(res, { result: null, error: { code: -32700, message: 'parse error' } });
      return;
    }

    const { result, error } = this.dispatchJsonRpc(method, params);
    writeJson(res, { result, error, id: 0 });
  }

  private dispatchJsonRpc(
    method: string,
    params: Record<string, unknown>,
  ): { result: unknown; error: JsonRpcError | null } {
    switch (method) {
      case 'Session.login':
        return this.handleLogin(params);
      case 'Session.renew':
        return { result: true, error: null };
      case 'Session.logout':
        return { result: true, error: null };
      case 'Device.listAllDetail':
        return { result: CANNED_DEVICE_DETAIL, error: null };
      case 'Room.getAll':
        return { result: CANNED_ROOMS, error: null };
      case 'Subsection.getAll':
        return { result: CANNED_SUBSECTIONS, error: null };
      default:
        return { result: null, error: { code: -32601, message: 'method not found' } };
    }
  }

  private handleLogin(params: Record<string, unknown>): {
    result: unknown;
    error: JsonRpcError | null;
  } {
    const user = String(params['username'] ?? '');
    const pass = String(params['password'] ?? '');
    if (user === this.username && pass === this.password) {
      return { result: SESSION_ID, error: null };
    }
    return { result: null, error: { code: -32001, message: 'access denied' } };
  }
}

/** Build the map key for a stored channel/parameter value. */
function valueKey(address: string, parameter: string): string {
  return `${address}|${parameter}`;
}

/** Narrow an XML-RPC value to a string, throwing a descriptive error otherwise. */
function asString(value: XmlRpcValue | undefined, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`expected a string for ${label}, got ${typeof value}`);
}

/** Write an XML-RPC response buffer with the CCU content type. */
function writeXml(res: ServerResponse, payload: Buffer): void {
  res.writeHead(200, {
    'Content-Type': 'text/xml; charset=iso-8859-1',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

/** Write a JSON-RPC response envelope. */
function writeJson(res: ServerResponse, envelope: Record<string, unknown>): void {
  const payload = Buffer.from(JSON.stringify(envelope), 'utf-8');
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

/** POST a buffer to a URL using `node:http`, resolving once the response ends. */
function postTo(targetUrl: string, body: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname || '/',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=iso-8859-1',
          'Content-Length': body.length,
        },
      },
      (res) => {
        res.on('data', () => {
          /* drain */
        });
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
