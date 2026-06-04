/**
 * Unit tests for the {@link Homematic} public facade.
 *
 * We construct a REAL {@link CentralUnit} pointed at a stub
 * {@link InterfaceClient} (via `makeInterfaceClient`) + an in-memory storage
 * backend, then INJECT it into the facade. Keeping the reference lets us drive
 * `valueReceived` through the central's own event bus and assert the facade's
 * public re-emission + read/write behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Homematic, createHomematicForTest } from '../../../src/api/homematic.js';
import { CentralUnit } from '../../../src/central/central-unit.js';
import type { InterfaceClient } from '../../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Interface, ParamsetKey } from '../../../src/support/constants.js';
import { ValidationError, DescriptionNotFoundError } from '../../../src/support/errors.js';
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
    MODE: {
      TYPE: 'ENUM',
      OPERATIONS: 1 | 2,
      FLAGS: 1,
      VALUE_LIST: ['OFF', 'ON', 'AUTO'],
      DEFAULT: 0,
      UNIT: '',
    },
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
    hm = createHomematicForTest(
      {
        host: '127.0.0.1',
        interfaces: ['HmIP-RF'],
        callback: { host: '127.0.0.1', port: 0 },
      },
      { central },
    );
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

  it('getValue resolves channel as index, numeric string, or full address identically', async () => {
    await pushValue('STATE', true, 1000);
    const byIndex = hm.getValue({ device: 'VCU1', channel: 1, parameter: 'STATE' });
    const byNumericString = hm.getValue({ device: 'VCU1', channel: '1', parameter: 'STATE' });
    const byFullAddress = hm.getValue({ device: 'VCU1', channel: 'VCU1:1', parameter: 'STATE' });
    expect(byIndex).toBe(true);
    expect(byNumericString).toBe(true);
    expect(byFullAddress).toBe(true);
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

  it('getConfigParams returns the MASTER specs (numeric + enum metadata)', () => {
    const params = hm.getConfigParams('VCU1:1');
    expect(params).toHaveLength(2);
    const numeric = params.find((p) => p.parameter === 'CYCLIC_INFO_MSG_DIS')!;
    expect(numeric).toMatchObject({ type: 'INTEGER', min: 0, max: 100, writable: true });
    const mode = params.find((p) => p.parameter === 'MODE')!;
    expect(mode).toMatchObject({
      type: 'ENUM',
      valueList: ['OFF', 'ON', 'AUTO'],
      default: 0,
      unit: '',
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

  it('maps a systemError into a public error event', async () => {
    const errors: Error[] = [];
    hm.on('error', (e) => errors.push(e));
    await central.eventBus.publish({
      type: 'systemError',
      interfaceId: INTERFACE_ID,
      code: 7,
      message: 'boom',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('boom');
  });

  it('deviceRemoved drops the device from the model and emits', async () => {
    const removed: string[] = [];
    hm.on('deviceRemoved', (e) => removed.push(e.device));
    await central.eventBus.publish({ type: 'deviceRemoved', address: 'VCU1' });
    expect(removed).toEqual(['VCU1']);
    expect(hm.devices()).toHaveLength(0);
  });

  it('deviceAdded rebuilds the device from the registry and emits', async () => {
    const added: string[] = [];
    hm.on('deviceAdded', (e) => added.push(e.device));
    // Re-publishing the same address re-indexes from the (still-populated) registry.
    await central.eventBus.publish({ type: 'deviceAdded', address: 'VCU1' });
    expect(added).toEqual(['VCU1']);
    expect(hm.devices()).toHaveLength(1);
  });

  it('once fires a listener a single time; off removes it', async () => {
    let onceCount = 0;
    hm.once('valueChanged', () => {
      onceCount += 1;
    });
    let offCount = 0;
    const listener = (): void => {
      offCount += 1;
    };
    hm.on('valueChanged', listener);
    hm.off('valueChanged', listener);
    await pushValue('STATE', true, 1000);
    await pushValue('STATE', false, 1001);
    expect(onceCount).toBe(1);
    expect(offCount).toBe(0);
  });

  it('getValue throws for an unknown string dpId', () => {
    expect(() => hm.getValue('no-such-id')).toThrow(ValidationError);
  });

  it('getValue throws for a structured ref to an unknown device', () => {
    expect(() => hm.getValue({ device: 'NOPE', channel: 1, parameter: 'STATE' })).toThrow(
      ValidationError,
    );
  });

  it('getConfigParams throws for an unknown channel/device', () => {
    expect(() => hm.getConfigParams('NOPE:1')).toThrow(ValidationError);
  });

  it('getConfig passes through raw values that have no MASTER spec', async () => {
    stub.masterValues = {
      CYCLIC_INFO_MSG_DIS: 30,
      EXTRA_RAW: 'hello',
      EXTRA_NULL: null,
      EXTRA_OBJ: { nested: 1 },
    };
    const config = await hm.getConfig('VCU1:1');
    expect(config['CYCLIC_INFO_MSG_DIS']).toBe(30);
    expect(config['EXTRA_RAW']).toBe('hello');
    expect(config['EXTRA_NULL']).toBeNull();
    // A non-primitive raw value is JSON-encoded defensively.
    expect(config['EXTRA_OBJ']).toBe('{"nested":1}');
  });

  it('surfaces a throwing valueChanged listener via the error event; other listeners still run', async () => {
    const errors: Error[] = [];
    const ran: string[] = [];
    const boom = new Error('listener boom');
    hm.on('error', (e) => errors.push(e));
    hm.on('valueChanged', () => {
      throw boom;
    });
    hm.on('valueChanged', () => ran.push('second'));

    await pushValue('STATE', true, 1000);

    expect(errors).toContain(boom);
    expect(ran).toEqual(['second']);
  });

  it('does not recurse when an error listener throws (falls back to console.error)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      hm.on('error', () => {
        throw new Error('error-listener boom');
      });
      hm.on('valueChanged', () => {
        throw new Error('value boom');
      });
      await pushValue('STATE', true, 1000);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('stop is idempotent and start after stop re-subscribes', async () => {
    await hm.stop();
    expect(hm.devices()).toHaveLength(0);
    await hm.stop(); // no-op
    await hm.start();
    expect(hm.devices()).toHaveLength(1);
  });
});

describe('Homematic facade — start() atomicity', () => {
  it('resets #started when central.start rejects so a retry calls central.start again', async () => {
    const startCalls: number[] = [];
    let attempt = 0;
    const fakeCentral = {
      registry: { getAll: () => [] },
      eventBus: { subscribe: () => () => {} },
      start: () => {
        attempt += 1;
        startCalls.push(attempt);
        return Promise.reject(new Error('central down'));
      },
      stop: () => Promise.resolve(),
    } as unknown as CentralUnit;

    const hm = createHomematicForTest(
      { host: '127.0.0.1', interfaces: ['HmIP-RF'], callback: { host: '127.0.0.1', port: 0 } },
      { central: fakeCentral },
    );

    await expect(hm.start()).rejects.toThrow('central down');
    // A second attempt is allowed (not wedged by the first failure).
    await expect(hm.start()).rejects.toThrow('central down');
    expect(startCalls).toEqual([1, 2]);
  });
});

describe('Homematic facade — getConfig strictness', () => {
  it('throws DescriptionNotFoundError when no MASTER spec is discovered for the channel', async () => {
    const readCalls: string[] = [];
    const fakeCentral = {
      registry: {
        getAll: () => [
          {
            address: 'VCU9',
            type: 'HmIP-X',
            interfaceId: INTERFACE_ID,
            channels: [{ address: 'VCU9:1', index: 1, parameters: new Map() }],
            raw: {},
          },
        ],
      },
      eventBus: { subscribe: () => () => {} },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      getParamsetSpec: () => undefined,
      readParamset: (_i: string, ch: string) => {
        readCalls.push(ch);
        return Promise.resolve({});
      },
    } as unknown as CentralUnit;

    const hm = createHomematicForTest(
      { host: '127.0.0.1', interfaces: ['HmIP-RF'], callback: { host: '127.0.0.1', port: 0 } },
      { central: fakeCentral },
    );
    await hm.start();

    await expect(hm.getConfig('VCU9:1')).rejects.toThrow(DescriptionNotFoundError);
    // The read must not happen when the spec is missing.
    expect(readCalls).toHaveLength(0);
  });
});
