/**
 * Unit tests for the {@link Homematic} public facade.
 *
 * We construct a REAL {@link CentralUnit} pointed at a stub
 * {@link InterfaceClient} (via `makeInterfaceClient`) + an in-memory storage
 * backend, then INJECT it into the facade. Keeping the reference lets us drive
 * `valueReceived` through the central's own event bus and assert the facade's
 * public re-emission + read/write behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Homematic } from '../../../src/api/homematic.js';
import { CentralUnit } from '../../../src/central/central-unit.js';
import type { InterfaceClient } from '../../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Interface, ParamsetKey } from '../../../src/support/constants.js';
import { ValidationError } from '../../../src/support/errors.js';
import { makeDpk } from '../../../src/support/dpk.js';
import type {
  DeviceDescription,
  ParameterData,
  XmlRpcValue,
} from '../../../src/transport/xmlrpc/types.js';

const CENTRAL_NAME = 'TestCCU';
const INTERFACE_ID = 'TestCCU-HmIP-RF';

const DEVICES: readonly DeviceDescription[] = [
  { ADDRESS: 'VCU1', TYPE: 'HmIP-SWDO', PARAMSETS: ['MASTER'], CHILDREN: ['VCU1:0', 'VCU1:1'] },
  { ADDRESS: 'VCU1:0', TYPE: 'MAINTENANCE', PARENT: 'VCU1', PARAMSETS: ['MASTER'] },
  { ADDRESS: 'VCU1:1', TYPE: 'SHUTTER_CONTACT', PARENT: 'VCU1', PARAMSETS: ['VALUES', 'MASTER'] },
];

const PARAMSETS: Readonly<Record<string, Record<string, ParameterData>>> = {
  'VCU1:1|VALUES': {
    STATE: { TYPE: 'BOOL', OPERATIONS: 1 | 2 | 4, FLAGS: 1 },
    LEVEL: { TYPE: 'FLOAT', OPERATIONS: 1 | 2 | 4, FLAGS: 1, MIN: 0, MAX: 100 },
  },
  'VCU1:1|MASTER': {
    CYCLIC_INFO_MSG_DIS: { TYPE: 'INTEGER', OPERATIONS: 1 | 2, FLAGS: 1, MIN: 0, MAX: 100 },
  },
  'VCU1:0|MASTER': {},
  'VCU1|MASTER': {},
};

class StubClient {
  public readonly setValueCalls: Array<{ channel: string; param: string; value: XmlRpcValue }> = [];
  public readonly putParamsetCalls: Array<{
    channel: string;
    key: string;
    values: Record<string, XmlRpcValue>;
  }> = [];
  public masterValues: Record<string, unknown> = { CYCLIC_INFO_MSG_DIS: 30 };

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
    paramsetKey: ParamsetKey,
  ): Promise<Record<string, ParameterData>> {
    return Promise.resolve(PARAMSETS[`${channelAddress}|${paramsetKey}`] ?? {});
  }
  public getParamset(): Promise<Record<string, unknown>> {
    return Promise.resolve({ ...this.masterValues });
  }
  public putParamset(
    channel: string,
    key: string,
    values: Record<string, XmlRpcValue>,
  ): Promise<void> {
    this.putParamsetCalls.push({ channel, key, values });
    return Promise.resolve();
  }
  public setValue(channel: string, param: string, value: XmlRpcValue): Promise<void> {
    this.setValueCalls.push({ channel, param, value });
    return Promise.resolve();
  }
  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function buildCentral(stub: StubClient): CentralUnit {
  return new CentralUnit({
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
}

describe('Homematic facade', () => {
  let stub: StubClient;
  let central: CentralUnit;
  let hm: Homematic;

  beforeEach(async () => {
    stub = new StubClient(INTERFACE_ID);
    central = buildCentral(stub);
    hm = new Homematic({
      host: '127.0.0.1',
      interfaces: ['HmIP-RF'],
      callback: { host: '127.0.0.1', port: 0 },
      central,
    });
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
  });

  async function pushValue(parameter: string, value: XmlRpcValue, at: number): Promise<void> {
    const dpk = makeDpk(INTERFACE_ID, 'VCU1:1', ParamsetKey.VALUES, parameter);
    await central.eventBus.publish({ type: 'valueReceived', dpk, value, receivedAt: at });
  }

  it('rejects an unknown interface name at construction', () => {
    expect(
      () =>
        new Homematic({
          host: '127.0.0.1',
          interfaces: ['Bogus-RF'],
          callback: { host: '127.0.0.1', port: 0 },
        }),
    ).toThrow(ValidationError);
  });

  it('start builds the model exposed by devices()', () => {
    const devices = hm.devices();
    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.address).toBe('VCU1');
    expect(device.type).toBe('HmIP-SWDO');
    const channel1 = device.channels.find((c) => c.address === 'VCU1:1')!;
    const params = channel1.dataPoints.map((dp) => dp.parameter).sort();
    expect(params).toEqual(['LEVEL', 'STATE']);
    const state = channel1.dataPoints.find((dp) => dp.parameter === 'STATE')!;
    expect(state.type).toBe('BOOL');
    expect(state.writable).toBe(true);
  });

  it('re-emits a valueReceived as a public valueChanged with prev/next', async () => {
    const events: Array<{
      dpId: string;
      device: string;
      channel: string;
      parameter: string;
      value: unknown;
      prevValue: unknown;
      ts: number;
    }> = [];
    hm.on('valueChanged', (e) => events.push(e));

    await pushValue('STATE', true, 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      device: 'VCU1',
      channel: 'VCU1:1',
      parameter: 'STATE',
      value: true,
      prevValue: null,
      ts: 1000,
    });

    // same value again → no second emit
    await pushValue('STATE', true, 1001);
    expect(events).toHaveLength(1);
  });

  it('getValue resolves a structured ref', async () => {
    await pushValue('STATE', true, 1000);
    expect(hm.getValue({ device: 'VCU1', channel: 1, parameter: 'STATE' })).toBe(true);
  });

  it('getValue resolves a string dpId', async () => {
    await pushValue('STATE', true, 1000);
    const id = hm
      .devices()[0]!
      .channels.find((c) => c.address === 'VCU1:1')!
      .dataPoints.find((dp) => dp.parameter === 'STATE')!.id;
    expect(hm.getValue(id)).toBe(true);
  });

  it('setValue validates+converts and writes the converted value', async () => {
    await hm.setValue({ device: 'VCU1', channel: 1, parameter: 'LEVEL' }, 42);
    expect(stub.setValueCalls).toEqual([{ channel: 'VCU1:1', param: 'LEVEL', value: 42 }]);
  });

  it('out-of-range setValue throws ValidationError and does NOT write', async () => {
    await expect(
      hm.setValue({ device: 'VCU1', channel: 1, parameter: 'LEVEL' }, 999),
    ).rejects.toThrow(ValidationError);
    expect(stub.setValueCalls).toHaveLength(0);
  });

  it('setValue throws for an unknown data point', async () => {
    await expect(hm.setValue({ device: 'VCU1', channel: 1, parameter: 'NOPE' }, 1)).rejects.toThrow(
      ValidationError,
    );
  });

  it('getConfigParams returns the MASTER specs', () => {
    const params = hm.getConfigParams('VCU1:1');
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      parameter: 'CYCLIC_INFO_MSG_DIS',
      type: 'INTEGER',
      min: 0,
      max: 100,
      writable: true,
    });
  });

  it('getConfig reads and converts MASTER values', async () => {
    const config = await hm.getConfig('VCU1:1');
    expect(config).toEqual({ CYCLIC_INFO_MSG_DIS: 30 });
  });

  it('setConfig validates then writes once with converted values', async () => {
    await hm.setConfig('VCU1:1', { CYCLIC_INFO_MSG_DIS: 55 });
    expect(stub.putParamsetCalls).toEqual([
      { channel: 'VCU1:1', key: 'MASTER', values: { CYCLIC_INFO_MSG_DIS: 55 } },
    ]);
  });

  it('setConfig with out-of-range throws and does NOT write', async () => {
    await expect(hm.setConfig('VCU1:1', { CYCLIC_INFO_MSG_DIS: 999 })).rejects.toThrow(
      ValidationError,
    );
    expect(stub.putParamsetCalls).toHaveLength(0);
  });

  it('setConfig with an unknown parameter throws and does NOT write', async () => {
    await expect(hm.setConfig('VCU1:1', { NOPE: 1 })).rejects.toThrow(ValidationError);
    expect(stub.putParamsetCalls).toHaveLength(0);
  });

  it('emits ready and connection events from the central bus', async () => {
    let ready = false;
    const conns: Array<{ interfaceId: string; state: string }> = [];
    hm.on('ready', () => {
      ready = true;
    });
    hm.on('connection', (e) => conns.push(e));
    await central.eventBus.publish({ type: 'ready' });
    await central.eventBus.publish({
      type: 'connectionStateChanged',
      interfaceId: INTERFACE_ID,
      state: 'CONNECTED',
    });
    expect(ready).toBe(true);
    expect(conns).toEqual([{ interfaceId: INTERFACE_ID, state: 'CONNECTED' }]);
  });
});
