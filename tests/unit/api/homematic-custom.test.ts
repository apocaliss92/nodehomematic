/**
 * Unit tests for the {@link Homematic} facade's custom-entity surface.
 *
 * We build a REAL {@link CentralUnit} pointed at a stub {@link InterfaceClient}
 * advertising an HmIP heating group (climate) and an HmIP switch, inject it into
 * the facade, then assert that `customEntities()` exposes typed snapshots and
 * that the command methods route a validated + converted write to the stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Homematic, createHomematicForTest } from '../../../src/api/homematic.js';
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

const READ_WRITE_EVENT = 1 | 2 | 4;

// A heating group (HmIP-HEATING) on `GRP1` with the IP-thermostat group fields
// on channel 1, plus a switch (HmIP-PS) on `SW1` with STATE on channel 3.
const DEVICES: readonly DeviceDescription[] = [
  { ADDRESS: 'GRP1', TYPE: 'HmIP-HEATING', PARAMSETS: ['MASTER'], CHILDREN: ['GRP1:1', 'GRP1:4'] },
  {
    ADDRESS: 'GRP1:1',
    TYPE: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
    PARENT: 'GRP1',
    PARAMSETS: ['VALUES'],
  },
  {
    ADDRESS: 'GRP1:4',
    TYPE: 'CLIMATECONTROL_FLOOR_TRANSCEIVER',
    PARENT: 'GRP1',
    PARAMSETS: ['VALUES'],
  },
  { ADDRESS: 'SW1', TYPE: 'HmIP-PS', PARAMSETS: ['MASTER'], CHILDREN: ['SW1:3'] },
  { ADDRESS: 'SW1:3', TYPE: 'SWITCH_TRANSCEIVER', PARENT: 'SW1', PARAMSETS: ['VALUES'] },
  // A flush-mount dimmer (HmIP-FDT, LEVEL on ch2 → light).
  { ADDRESS: 'DIM1', TYPE: 'HmIP-FDT', PARAMSETS: ['MASTER'], CHILDREN: ['DIM1:2'] },
  { ADDRESS: 'DIM1:2', TYPE: 'DIMMER_TRANSCEIVER', PARENT: 'DIM1', PARAMSETS: ['VALUES'] },
  // A roller shutter (HmIP-BROLL, cover on ch4 → cover).
  { ADDRESS: 'COV1', TYPE: 'HmIP-BROLL', PARAMSETS: ['MASTER'], CHILDREN: ['COV1:4'] },
  { ADDRESS: 'COV1:4', TYPE: 'SHUTTER_TRANSCEIVER', PARENT: 'COV1', PARAMSETS: ['VALUES'] },
  // A door-lock drive (HmIP-DLD, LOCK_* on ch1 → lock).
  { ADDRESS: 'LCK1', TYPE: 'HmIP-DLD', PARAMSETS: ['MASTER'], CHILDREN: ['LCK1:1'] },
  { ADDRESS: 'LCK1:1', TYPE: 'LOCK_TRANSCEIVER', PARENT: 'LCK1', PARAMSETS: ['VALUES'] },
];

const PARAMSETS: Readonly<Record<string, Record<string, ParameterData>>> = {
  'GRP1:1|VALUES': {
    SET_POINT_TEMPERATURE: {
      TYPE: 'FLOAT',
      OPERATIONS: READ_WRITE_EVENT,
      FLAGS: 1,
      MIN: 4.5,
      MAX: 30.5,
    },
    ACTUAL_TEMPERATURE: { TYPE: 'FLOAT', OPERATIONS: 1 | 4, FLAGS: 1, MIN: -50, MAX: 50 },
    HUMIDITY: { TYPE: 'INTEGER', OPERATIONS: 1 | 4, FLAGS: 1, MIN: 0, MAX: 100 },
    SET_POINT_MODE: { TYPE: 'INTEGER', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1, MIN: 0, MAX: 2 },
    CONTROL_MODE: { TYPE: 'INTEGER', OPERATIONS: 1 | 2, FLAGS: 1, MIN: 0, MAX: 3 },
    BOOST_MODE: { TYPE: 'BOOL', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1 },
    ACTIVE_PROFILE: { TYPE: 'INTEGER', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1, MIN: 1, MAX: 3 },
    LEVEL: { TYPE: 'FLOAT', OPERATIONS: 1 | 4, FLAGS: 1, MIN: 0, MAX: 1 },
  },
  'GRP1:4|VALUES': {
    STATE: { TYPE: 'BOOL', OPERATIONS: 1 | 4, FLAGS: 1 },
  },
  'SW1:3|VALUES': {
    STATE: { TYPE: 'BOOL', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1 },
  },
  'DIM1:2|VALUES': {
    LEVEL: { TYPE: 'FLOAT', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1, MIN: 0, MAX: 1 },
  },
  'COV1:4|VALUES': {
    LEVEL: { TYPE: 'FLOAT', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1, MIN: 0, MAX: 1 },
    // STOP/LOCK_TARGET_LEVEL are write-only ACTIONs on real HmIP firmware; the
    // model only builds data points for readable/event params, so they are given
    // the EVENT bit here so the command-routing path can be exercised. See the
    // task report: pure write-only command fields are NOT modelled today.
    STOP: { TYPE: 'ACTION', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1 },
    ACTIVITY_STATE: {
      TYPE: 'ENUM',
      OPERATIONS: 1 | 4,
      FLAGS: 1,
      VALUE_LIST: ['IDLE', 'UP', 'DOWN'],
    },
  },
  'LCK1:1|VALUES': {
    LOCK_STATE: {
      TYPE: 'ENUM',
      OPERATIONS: 1 | 4,
      FLAGS: 1,
      VALUE_LIST: ['UNKNOWN', 'LOCKED', 'UNLOCKED'],
    },
    LOCK_TARGET_LEVEL: {
      TYPE: 'ENUM',
      OPERATIONS: READ_WRITE_EVENT,
      FLAGS: 1,
      VALUE_LIST: ['LOCKED', 'UNLOCKED', 'OPEN'],
    },
  },
  'GRP1|MASTER': {},
  'SW1|MASTER': {},
  'DIM1|MASTER': {},
  'COV1|MASTER': {},
  'LCK1|MASTER': {},
};

class StubClient {
  public readonly setValueCalls: Array<{ channel: string; param: string; value: XmlRpcValue }> = [];

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
    return Promise.resolve({});
  }
  public putParamset(): Promise<void> {
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

describe('Homematic facade — custom entities', () => {
  let stub: StubClient;
  let central: CentralUnit;
  let hm: Homematic;

  beforeEach(async () => {
    stub = new StubClient(INTERFACE_ID);
    central = buildCentral(stub);
    hm = createHomematicForTest(
      { host: '127.0.0.1', interfaces: ['HmIP-RF'], callback: { host: '127.0.0.1', port: 0 } },
      { central },
    );
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
  });

  async function push(
    channelAddress: string,
    parameter: string,
    value: XmlRpcValue,
    at: number,
  ): Promise<void> {
    const dpk = makeDpk(INTERFACE_ID, channelAddress, ParamsetKey.VALUES, parameter);
    await central.eventBus.publish({ type: 'valueReceived', dpk, value, receivedAt: at });
  }

  it('customEntities() exposes a climate group and a switch snapshot', async () => {
    await push('GRP1:1', 'SET_POINT_TEMPERATURE', 21, 1000);
    await push('GRP1:1', 'ACTUAL_TEMPERATURE', 20.5, 1001);
    await push('GRP1:1', 'HUMIDITY', 45, 1002);
    await push('GRP1:1', 'SET_POINT_MODE', 1, 1003);
    await push('SW1:3', 'STATE', true, 1004);

    const entities = hm.customEntities();
    const climate = entities.find((e) => e.kind === 'climate');
    const sw = entities.find((e) => e.kind === 'switch');

    expect(climate).toMatchObject({
      kind: 'climate',
      device: 'GRP1',
      channel: 'GRP1:1',
      currentTemperature: 20.5,
      targetTemperature: 21,
      currentHumidity: 45,
      mode: 'heat',
      targetTemperatureStep: 0.5,
    });
    expect(sw).toMatchObject({ kind: 'switch', device: 'SW1', channel: 'SW1:3', isOn: true });
  });

  it('climateSetTemperature routes a converted SET_POINT_TEMPERATURE write', async () => {
    await hm.climateSetTemperature('GRP1', 1, 22);
    expect(stub.setValueCalls).toEqual([
      { channel: 'GRP1:1', param: 'SET_POINT_TEMPERATURE', value: 22 },
    ]);
  });

  it('climateSetTemperature accepts a full channel address', async () => {
    await hm.climateSetTemperature('GRP1', 'GRP1:1', 22);
    expect(stub.setValueCalls).toEqual([
      { channel: 'GRP1:1', param: 'SET_POINT_TEMPERATURE', value: 22 },
    ]);
  });

  it('climateSetMode off switches CONTROL_MODE then drops the target', async () => {
    await hm.climateSetMode('GRP1', 1, 'off');
    expect(stub.setValueCalls).toEqual([
      { channel: 'GRP1:1', param: 'CONTROL_MODE', value: 1 },
      { channel: 'GRP1:1', param: 'SET_POINT_TEMPERATURE', value: 4.5 },
    ]);
  });

  it('climateSetBoost routes a BOOST_MODE write', async () => {
    await hm.climateSetBoost('GRP1', 1, true);
    expect(stub.setValueCalls).toEqual([{ channel: 'GRP1:1', param: 'BOOST_MODE', value: true }]);
  });

  it('switchTurnOn / switchTurnOff route STATE writes', async () => {
    await hm.switchTurnOn('SW1', 3);
    await hm.switchTurnOff('SW1', 3);
    expect(stub.setValueCalls).toEqual([
      { channel: 'SW1:3', param: 'STATE', value: true },
      { channel: 'SW1:3', param: 'STATE', value: false },
    ]);
  });

  it('a climate command on a non-climate device throws ValidationError', async () => {
    await expect(hm.climateSetTemperature('SW1', 3, 22)).rejects.toThrow(ValidationError);
    expect(stub.setValueCalls).toHaveLength(0);
  });

  it('a command for an unknown device/channel throws ValidationError', async () => {
    await expect(hm.switchTurnOn('NOPE', 1)).rejects.toThrow(ValidationError);
  });

  it('an out-of-range climate temperature is clamped before writing', async () => {
    // The entity clamps to [minTemp, maxTemp] from the dp metadata (4.5..30.5).
    await hm.climateSetTemperature('GRP1', 1, 99);
    expect(stub.setValueCalls).toEqual([
      { channel: 'GRP1:1', param: 'SET_POINT_TEMPERATURE', value: 30.5 },
    ]);
  });

  it('exposes light, cover and lock entities in the snapshot', async () => {
    await push('DIM1:2', 'LEVEL', 0.5, 1100);
    await push('COV1:4', 'LEVEL', 0.25, 1101);

    const entities = hm.customEntities();
    const light = entities.find((e) => e.kind === 'light');
    const cover = entities.find((e) => e.kind === 'cover');
    const lock = entities.find((e) => e.kind === 'lock');

    expect(light).toMatchObject({ kind: 'light', device: 'DIM1', isOn: true });
    expect(cover).toMatchObject({ kind: 'cover', device: 'COV1', currentPosition: 25 });
    expect(lock).toMatchObject({ kind: 'lock', device: 'LCK1', isLocked: false });
  });

  it('lightTurnOn / lightSetBrightness / lightTurnOff route converted LEVEL writes', async () => {
    await hm.lightTurnOn('DIM1', 2);
    await hm.lightSetBrightness('DIM1', 2, 128);
    await hm.lightTurnOff('DIM1', 2);
    expect(stub.setValueCalls).toEqual([
      { channel: 'DIM1:2', param: 'LEVEL', value: 1 },
      { channel: 'DIM1:2', param: 'LEVEL', value: 128 / 255 },
      { channel: 'DIM1:2', param: 'LEVEL', value: 0 },
    ]);
  });

  it('lightTurnOn with explicit brightness routes the converted LEVEL', async () => {
    await hm.lightTurnOn('DIM1', 2, 51);
    expect(stub.setValueCalls).toEqual([{ channel: 'DIM1:2', param: 'LEVEL', value: 51 / 255 }]);
  });

  it('coverOpen / coverClose / coverStop / coverSetPosition route the right writes', async () => {
    await hm.coverOpen('COV1', 4);
    await hm.coverClose('COV1', 4);
    await hm.coverStop('COV1', 4);
    await hm.coverSetPosition('COV1', 4, 50);
    expect(stub.setValueCalls).toEqual([
      { channel: 'COV1:4', param: 'LEVEL', value: 1 },
      { channel: 'COV1:4', param: 'LEVEL', value: 0 },
      { channel: 'COV1:4', param: 'STOP', value: true },
      { channel: 'COV1:4', param: 'LEVEL', value: 0.5 },
    ]);
  });

  it('lockLock / lockUnlock / lockOpen route LOCK_TARGET_LEVEL writes', async () => {
    await hm.lockLock('LCK1', 1);
    await hm.lockUnlock('LCK1', 1);
    await hm.lockOpen('LCK1', 1);
    expect(stub.setValueCalls).toEqual([
      { channel: 'LCK1:1', param: 'LOCK_TARGET_LEVEL', value: 'LOCKED' },
      { channel: 'LCK1:1', param: 'LOCK_TARGET_LEVEL', value: 'UNLOCKED' },
      { channel: 'LCK1:1', param: 'LOCK_TARGET_LEVEL', value: 'OPEN' },
    ]);
  });

  it('a wrong-kind command throws ValidationError (light command on a switch)', async () => {
    await expect(hm.lightTurnOn('SW1', 3)).rejects.toThrow(ValidationError);
    await expect(hm.coverOpen('SW1', 3)).rejects.toThrow(ValidationError);
    await expect(hm.lockLock('SW1', 3)).rejects.toThrow(ValidationError);
    await expect(hm.switchTurnOn('GRP1', 1)).rejects.toThrow(ValidationError);
    expect(stub.setValueCalls).toHaveLength(0);
  });

  it('rebuilds custom entities on deviceRemoved', async () => {
    await central.eventBus.publish({ type: 'deviceRemoved', address: 'SW1' });
    const entities = hm.customEntities();
    expect(entities.some((e) => e.device === 'SW1')).toBe(false);
    expect(entities.some((e) => e.kind === 'climate')).toBe(true);
  });
});
