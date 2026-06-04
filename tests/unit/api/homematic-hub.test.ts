/**
 * Unit tests for the {@link Homematic} facade's Phase-5 hub surface (system
 * variables + programs) and the rooms/functions wiring.
 *
 * We build a REAL {@link CentralUnit} with `credentials` set + a stub
 * {@link InterfaceClient} (no transport) AND an injected fake JSON-RPC client
 * that returns canned `SysVar.getAll` / `Program.getAll` / `ReGa.runScript`
 * results. After start() the facade exposes the snapshots, validates writability
 * before any write, resolves programs by id-or-name, and merges the ReGa
 * rooms/functions mapping into devices().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Homematic, createHomematicForTest } from '../../../src/api/homematic.js';
import { CentralUnit, type JsonRpcClientLike } from '../../../src/central/central-unit.js';
import type { InterfaceClient } from '../../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Interface } from '../../../src/support/constants.js';
import { ValidationError } from '../../../src/support/errors.js';
import { JsonRpcMethod } from '../../../src/transport/jsonrpc/methods.js';
import { GET_ROOMS_FUNCTIONS, SYSVAR_DESCRIPTIONS } from '../../../src/central/rega/scripts.js';
import type { DeviceDescription, ParameterData } from '../../../src/transport/xmlrpc/types.js';

const CENTRAL_NAME = 'TestCCU';
const INTERFACE_ID = 'TestCCU-HmIP-RF';

const DEVICES: readonly DeviceDescription[] = [
  { ADDRESS: 'VCU1', TYPE: 'HmIP-SWDO', PARAMSETS: ['MASTER'], CHILDREN: ['VCU1:0', 'VCU1:1'] },
  { ADDRESS: 'VCU1:0', TYPE: 'MAINTENANCE', PARENT: 'VCU1', PARAMSETS: ['MASTER'] },
  { ADDRESS: 'VCU1:1', TYPE: 'SHUTTER_CONTACT', PARENT: 'VCU1', PARAMSETS: ['VALUES', 'MASTER'] },
];

const PARAMSETS: Readonly<Record<string, Record<string, ParameterData>>> = {
  'VCU1:1|VALUES': { STATE: { TYPE: 'BOOL', OPERATIONS: 1 | 2 | 4, FLAGS: 1 } },
  'VCU1:1|MASTER': {},
  'VCU1:0|MASTER': {},
  'VCU1|MASTER': {},
};

class StubClient {
  public constructor(private readonly idValue: string) {}
  public get interfaceId(): string {
    return this.idValue;
  }
  public initProxy(): Promise<void> {
    return Promise.resolve();
  }
  public deinitProxy(): Promise<void> {
    return Promise.resolve();
  }
  public listDevices(): Promise<DeviceDescription[]> {
    return Promise.resolve([...DEVICES]);
  }
  public getParamsetDescription(
    channelAddress: string,
    paramsetKey: string,
  ): Promise<Record<string, ParameterData>> {
    return Promise.resolve(PARAMSETS[`${channelAddress}|${paramsetKey}`] ?? {});
  }
  public getParamset(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

interface PostRecord {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Fake JSON-RPC client routed by method. ReGa is discriminated by inspecting the
 * posted `script` body. Results mirror the real client: `post` returns the bare
 * `result` (the ReGa script output as a JSON string).
 */
class FakeJsonClient implements JsonRpcClientLike {
  public readonly posts: PostRecord[] = [];

  public post(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.posts.push({ method, params });
    if (method === JsonRpcMethod.SYSVAR_GET_ALL) {
      return Promise.resolve([
        { id: '1', name: 'Presence', type: 'LOGIC', value: 'true', isInternal: false },
        { id: '2', name: 'Temp', type: 'FLOAT', value: '21.5', unit: '°C', isInternal: false },
      ]);
    }
    if (method === JsonRpcMethod.PROGRAM_GET_ALL) {
      return Promise.resolve([
        { id: '100', name: 'Morning', isActive: true, isInternal: false },
        { id: '101', name: 'Away', isActive: false, isInternal: false },
      ]);
    }
    if (method === JsonRpcMethod.SYSVAR_SET_FLOAT || method === JsonRpcMethod.SYSVAR_SET_BOOL) {
      return Promise.resolve(true);
    }
    if (method === JsonRpcMethod.PROGRAM_EXECUTE) {
      return Promise.resolve(true);
    }
    if (method === JsonRpcMethod.REGA_RUN_SCRIPT) {
      const script = String(params?.['script'] ?? '');
      if (script === SYSVAR_DESCRIPTIONS) {
        // Only var 1 carries HAHM → writable; var 2 read-only.
        return Promise.resolve(
          JSON.stringify([
            { id: '1', description: 'extended HAHM sysvar' },
            { id: '2', description: 'plain sensor' },
          ]),
        );
      }
      if (script === GET_ROOMS_FUNCTIONS) {
        return Promise.resolve(
          JSON.stringify({
            rooms: { 'VCU1:1': ['Kitchen'] },
            functions: { 'VCU1:1': ['Light'] },
          }),
        );
      }
      return Promise.resolve('{}');
    }
    // Discovery detail methods are best-effort; an empty array is tolerated.
    return Promise.resolve([]);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function buildCentral(stub: StubClient, jsonClient: JsonRpcClientLike): CentralUnit {
  return new CentralUnit({
    centralName: CENTRAL_NAME,
    host: '127.0.0.1',
    interfaces: [Interface.HMIP_RF],
    credentials: { username: 'Admin', password: 'secret' },
    callback: { host: '127.0.0.1', port: 0 },
    storageBackend: new InMemoryStorageBackend(),
    makeInterfaceClient: () => stub as unknown as InterfaceClient,
    jsonClient,
    timings: { connectionCheckMs: 60_000, valueRefreshMs: 60_000 },
    tcpProbe: () => Promise.resolve(true),
    recoverySleep: () => Promise.resolve(),
    fetchInitialValues: false,
  });
}

describe('Homematic facade — hub (sysvars + programs + rooms/functions)', () => {
  let jsonClient: FakeJsonClient;
  let hm: Homematic;

  beforeEach(async () => {
    jsonClient = new FakeJsonClient();
    const central = buildCentral(new StubClient(INTERFACE_ID), jsonClient);
    hm = createHomematicForTest(
      { host: '127.0.0.1', interfaces: ['HmIP-RF'], callback: { host: '127.0.0.1', port: 0 } },
      { central },
    );
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
  });

  it('populates systemVariables() after start with parsed values + writable flags', () => {
    const sysvars = hm.systemVariables();
    expect(sysvars).toHaveLength(2);
    const presence = sysvars.find((v) => v.name === 'Presence')!;
    expect(presence.type).toBe('LOGIC');
    expect(presence.value).toBe(true);
    expect(presence.writable).toBe(true);
    const temp = sysvars.find((v) => v.name === 'Temp')!;
    expect(temp.value).toBe(21.5);
    expect(temp.unit).toBe('°C');
    expect(temp.writable).toBe(false);
  });

  it('populates programs() after start', () => {
    const programs = hm.programs();
    expect(programs.map((p) => p.name).sort()).toEqual(['Away', 'Morning']);
  });

  it('setSystemVariable on a read-only var throws ValidationError without writing', async () => {
    const before = jsonClient.posts.length;
    await expect(hm.setSystemVariable('Temp', 22)).rejects.toBeInstanceOf(ValidationError);
    // No additional post was made (no setFloat/setBool reached the client).
    expect(jsonClient.posts.length).toBe(before);
  });

  it('setSystemVariable on a writable var delegates to the hub', async () => {
    await hm.setSystemVariable('Presence', false);
    const last = jsonClient.posts.at(-1)!;
    expect(last.method).toBe(JsonRpcMethod.SYSVAR_SET_BOOL);
    expect(last.params).toMatchObject({ name: 'Presence', value: 0 });
  });

  it('setSystemVariable on an unknown var throws ValidationError', async () => {
    await expect(hm.setSystemVariable('Nope', 1)).rejects.toBeInstanceOf(ValidationError);
  });

  it('runProgram resolves by name and executes', async () => {
    await hm.runProgram('Morning');
    const last = jsonClient.posts.at(-1)!;
    expect(last.method).toBe(JsonRpcMethod.PROGRAM_EXECUTE);
    expect(last.params).toMatchObject({ id: '100' });
  });

  it('runProgram resolves by id and executes', async () => {
    await hm.runProgram('101');
    const last = jsonClient.posts.at(-1)!;
    expect(last.params).toMatchObject({ id: '101' });
  });

  it('runProgram on an unknown id/name throws ValidationError', async () => {
    await expect(hm.runProgram('ghost')).rejects.toBeInstanceOf(ValidationError);
  });

  it('merges the ReGa rooms/functions mapping into devices()', () => {
    const device = hm.devices().find((d) => d.address === 'VCU1')!;
    expect(device.rooms).toEqual(['Kitchen']);
    expect(device.functions).toEqual(['Light']);
  });

  it('refreshHub re-fetches the snapshots', async () => {
    await hm.refreshHub();
    expect(hm.systemVariables()).toHaveLength(2);
    expect(hm.programs()).toHaveLength(2);
  });
});

describe('Homematic facade — hub unavailable without credentials', () => {
  it('exposes empty snapshots and throws on hub commands', async () => {
    const central = new CentralUnit({
      centralName: CENTRAL_NAME,
      host: '127.0.0.1',
      interfaces: [Interface.HMIP_RF],
      callback: { host: '127.0.0.1', port: 0 },
      storageBackend: new InMemoryStorageBackend(),
      makeInterfaceClient: () => new StubClient(INTERFACE_ID) as unknown as InterfaceClient,
      timings: { connectionCheckMs: 60_000, valueRefreshMs: 60_000 },
      tcpProbe: () => Promise.resolve(true),
      recoverySleep: () => Promise.resolve(),
      fetchInitialValues: false,
    });
    const hm = createHomematicForTest(
      { host: '127.0.0.1', interfaces: ['HmIP-RF'], callback: { host: '127.0.0.1', port: 0 } },
      { central },
    );
    await hm.start();
    try {
      expect(hm.systemVariables()).toEqual([]);
      expect(hm.programs()).toEqual([]);
      await expect(hm.getSystemVariable('X')).rejects.toBeInstanceOf(ValidationError);
      await expect(hm.runProgram('X')).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await hm.stop();
    }
  });
});
