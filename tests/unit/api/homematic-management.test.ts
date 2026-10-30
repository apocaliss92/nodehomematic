/**
 * The facade's CCU-management surface wired through a real {@link CentralUnit}
 * with stub interface clients and a fake JSON-RPC client.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Homematic, createHomematicForTest } from '../../../src/api/homematic.js';
import { HM_DELETE_FLAGS } from '../../../src/api/types.js';
import { CentralUnit, type JsonRpcClientLike } from '../../../src/central/central-unit.js';
import type { InterfaceClient, InstallModeCall } from '../../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Interface } from '../../../src/support/constants.js';
import { ValidationError } from '../../../src/support/errors.js';
import { JsonRpcMethod } from '../../../src/transport/jsonrpc/methods.js';
import type { DeviceDescription } from '../../../src/transport/xmlrpc/types.js';

const DEVICES: readonly DeviceDescription[] = [
  { ADDRESS: 'VCU1', TYPE: 'HmIP-SWDO', PARAMSETS: ['MASTER'], CHILDREN: ['VCU1:0'] },
  { ADDRESS: 'VCU1:0', TYPE: 'MAINTENANCE', PARENT: 'VCU1', PARAMSETS: ['MASTER'] },
];

class StubClient {
  public readonly installCalls: InstallModeCall[] = [];
  public readonly deleted: { address: string; flags: number }[] = [];
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
  public getParamsetDescription(): Promise<Record<string, never>> {
    return Promise.resolve({});
  }
  public getParamset(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
  public listBidcosInterfaces(): Promise<[]> {
    return Promise.resolve([]);
  }
  public setInstallMode(request: InstallModeCall): Promise<void> {
    this.installCalls.push(request);
    return Promise.resolve();
  }
  public getInstallModeRemaining(): Promise<number | null> {
    return Promise.resolve(17);
  }
  public deleteDevice(address: string, flags: number): Promise<void> {
    this.deleted.push({ address, flags });
    return Promise.resolve();
  }
}

class FakeJson implements JsonRpcClientLike {
  public readonly methods: string[] = [];
  public post(method: string): Promise<unknown> {
    this.methods.push(method);
    if (method === JsonRpcMethod.CCU_GET_VERSION) return Promise.resolve('3.75.7');
    if (method === JsonRpcMethod.CCU_GET_SERIAL) return Promise.resolve('SER1');
    if (method === JsonRpcMethod.CCU_GET_HEATING_GROUP_LIST) {
      return Promise.resolve(
        JSON.stringify({ groups: [{ id: 5, groupProperties: { NAME: 'G' } }] }),
      );
    }
    return Promise.resolve([]);
  }
  public close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Homematic facade — CCU management', () => {
  let stub: StubClient;
  let json: FakeJson;
  let hm: Homematic;

  beforeEach(async () => {
    stub = new StubClient('TestCCU-HmIP-RF');
    json = new FakeJson();
    const central = new CentralUnit({
      centralName: 'TestCCU',
      host: '127.0.0.1',
      interfaces: [Interface.HMIP_RF],
      credentials: { username: 'Admin', password: 'secret' },
      callback: { host: '127.0.0.1', port: 0 },
      storageBackend: new InMemoryStorageBackend(),
      makeInterfaceClient: () => stub as unknown as InterfaceClient,
      jsonClient: json,
      timings: { connectionCheckMs: 60_000, valueRefreshMs: 60_000 },
      tcpProbe: () => Promise.resolve(true),
      recoverySleep: () => Promise.resolve(),
      fetchInitialValues: false,
    });
    hm = createHomematicForTest(
      { host: '127.0.0.1', interfaces: ['HmIP-RF'], callback: { host: '127.0.0.1', port: 0 } },
      { central },
    );
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
  });

  it('setInstallMode / getInstallMode reach the configured interface', async () => {
    await hm.setInstallMode({ interface: 'HmIP-RF', on: true, seconds: 90 });
    expect(stub.installCalls).toEqual([{ on: true, seconds: 90 }]);
    await expect(hm.getInstallMode('HmIP-RF')).resolves.toBe(17);
  });

  it('deleteDevice routes through the owning interface with the flags', async () => {
    await hm.deleteDevice('VCU1', HM_DELETE_FLAGS.RESET | HM_DELETE_FLAGS.FORCE);
    expect(stub.deleted).toEqual([{ address: 'VCU1', flags: 3 }]);
  });

  it('deleteDevice rejects an unknown device and invalid flags before touching the CCU', async () => {
    await expect(hm.deleteDevice('NOPE', 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(hm.deleteDevice('VCU1', 8)).rejects.toBeInstanceOf(ValidationError);
    await expect(hm.deleteDevice('VCU1', 1.5)).rejects.toBeInstanceOf(ValidationError);
    expect(stub.deleted).toEqual([]);
  });

  it('ccuInfo and groups use the session-bound JSON-RPC client', async () => {
    await expect(hm.groups()).resolves.toMatchObject([{ id: 5, name: 'G', members: [] }]);
    const info = await hm.ccuInfo();
    expect(info).toMatchObject({ version: '3.75.7', serial: 'SER1' });
  });

  it('management calls before start() are refused', async () => {
    const idle = new Homematic({
      host: '127.0.0.1',
      interfaces: ['HmIP-RF'],
      callback: { host: '127.0.0.1', port: 0 },
    });
    await expect(idle.listInterfaces()).rejects.toBeInstanceOf(ValidationError);
  });
});
