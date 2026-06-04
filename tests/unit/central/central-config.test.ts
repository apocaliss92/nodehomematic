/**
 * Unit tests for the Phase 3 config surface on {@link CentralUnit}:
 * `getParamsetSpec` (reads the paramset description cache) and
 * `readParamset` / `writeParamset` (route to the right {@link InterfaceClient}
 * by interfaceId). A stub InterfaceClient records the calls; a real CentralUnit
 * is driven through a cold discovery so its paramset cache is populated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CentralUnit } from '../../../src/central/central-unit.js';
import type { InterfaceClient } from '../../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Interface, ParamsetKey } from '../../../src/support/constants.js';
import type {
  DeviceDescription,
  ParameterData,
  XmlRpcValue,
} from '../../../src/transport/xmlrpc/types.js';

const CENTRAL_NAME = 'TestCCU';
const INTERFACE_ID = 'TestCCU-HmIP-RF';

const DEVICES: readonly DeviceDescription[] = [
  {
    ADDRESS: 'VCU1',
    TYPE: 'HmIP-SWDO',
    PARAMSETS: ['MASTER'],
    CHILDREN: ['VCU1:0', 'VCU1:1'],
  },
  { ADDRESS: 'VCU1:0', TYPE: 'MAINTENANCE', PARENT: 'VCU1', PARAMSETS: ['MASTER'] },
  { ADDRESS: 'VCU1:1', TYPE: 'SHUTTER_CONTACT', PARENT: 'VCU1', PARAMSETS: ['VALUES', 'MASTER'] },
];

const PARAMSETS: Readonly<Record<string, Record<string, ParameterData>>> = {
  'VCU1:1|VALUES': { STATE: { TYPE: 'BOOL', OPERATIONS: 1 | 2 | 4, FLAGS: 1 } },
  'VCU1:1|MASTER': {
    CYCLIC_INFO_MSG_DIS: { TYPE: 'INTEGER', OPERATIONS: 1 | 2, FLAGS: 1, MIN: 0, MAX: 100 },
  },
  'VCU1:0|MASTER': {},
  'VCU1|MASTER': {},
};

/** A stub InterfaceClient: serves discovery and records read/write paramset calls. */
class StubClient {
  public readonly getParamsetCalls: Array<{ channel: string; key: string }> = [];
  public readonly putParamsetCalls: Array<{
    channel: string;
    key: string;
    values: Record<string, XmlRpcValue>;
  }> = [];

  public constructor(private readonly interfaceIdValue: string) {}

  public get interfaceId(): string {
    return this.interfaceIdValue;
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
    paramsetKey: ParamsetKey,
  ): Promise<Record<string, ParameterData>> {
    return Promise.resolve(PARAMSETS[`${channelAddress}|${paramsetKey}`] ?? {});
  }

  public getParamset(
    channelAddress: string,
    paramsetKey: string,
  ): Promise<Record<string, unknown>> {
    this.getParamsetCalls.push({ channel: channelAddress, key: paramsetKey });
    return Promise.resolve({ CYCLIC_INFO_MSG_DIS: 42 });
  }

  public putParamset(
    channelAddress: string,
    paramsetKey: string,
    values: Record<string, XmlRpcValue>,
  ): Promise<void> {
    this.putParamsetCalls.push({ channel: channelAddress, key: paramsetKey, values });
    return Promise.resolve();
  }

  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

describe('CentralUnit config surface', () => {
  let stub: StubClient;
  let central: CentralUnit;

  beforeEach(async () => {
    stub = new StubClient(INTERFACE_ID);
    central = new CentralUnit({
      centralName: CENTRAL_NAME,
      host: '127.0.0.1',
      interfaces: [Interface.HMIP_RF],
      callback: { host: '127.0.0.1', port: 0 },
      storageBackend: new InMemoryStorageBackend(),
      makeInterfaceClient: () => stub as unknown as InterfaceClient,
      timings: { connectionCheckMs: 60_000, valueRefreshMs: 60_000 },
      tcpProbe: () => Promise.resolve(true),
      recoverySleep: () => Promise.resolve(),
    });
    await central.start();
  });

  afterEach(async () => {
    await central.stop();
  });

  it('getParamsetSpec returns the discovered MASTER description', () => {
    const spec = central.getParamsetSpec(INTERFACE_ID, 'VCU1:1', ParamsetKey.MASTER);
    expect(spec).toBeDefined();
    expect(spec?.['CYCLIC_INFO_MSG_DIS']).toMatchObject({ TYPE: 'INTEGER', MIN: 0, MAX: 100 });
  });

  it('getParamsetSpec returns undefined for an unknown channel/paramset', () => {
    expect(central.getParamsetSpec(INTERFACE_ID, 'NOPE:1', ParamsetKey.MASTER)).toBeUndefined();
  });

  it('readParamset routes to the right client', async () => {
    const values = await central.readParamset(INTERFACE_ID, 'VCU1:1', ParamsetKey.MASTER);
    expect(values).toEqual({ CYCLIC_INFO_MSG_DIS: 42 });
    expect(stub.getParamsetCalls).toEqual([{ channel: 'VCU1:1', key: 'MASTER' }]);
  });

  it('writeParamset routes to the right client with the values struct', async () => {
    await central.writeParamset(INTERFACE_ID, 'VCU1:1', ParamsetKey.MASTER, {
      CYCLIC_INFO_MSG_DIS: 7,
    });
    expect(stub.putParamsetCalls).toEqual([
      { channel: 'VCU1:1', key: 'MASTER', values: { CYCLIC_INFO_MSG_DIS: 7 } },
    ]);
  });

  it('readParamset throws on an unknown interface', async () => {
    await expect(central.readParamset('bogus', 'VCU1:1', ParamsetKey.MASTER)).rejects.toThrow(
      /unknown interface/,
    );
  });

  it('writeParamset throws on an unknown interface', async () => {
    await expect(central.writeParamset('bogus', 'VCU1:1', ParamsetKey.MASTER, {})).rejects.toThrow(
      /unknown interface/,
    );
  });
});
