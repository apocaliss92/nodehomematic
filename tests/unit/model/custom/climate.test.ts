import { describe, it, expect } from 'vitest';
import { ClimateEntity } from '../../../../src/model/custom/climate.js';
import { Field } from '../../../../src/model/custom/fields.js';
import { GenericDataPoint } from '../../../../src/model/data-point.js';
import type { ParameterSpec } from '../../../../src/central/graph.js';
import { ModelDevice } from '../../../../src/model/device.js';
import { ModelChannel } from '../../../../src/model/channel.js';
import { makeDpk } from '../../../../src/support/dpk.js';
import { ParameterType, Operations } from '../../../../src/support/constants.js';
import { buildCustomEntities } from '../../../../src/model/custom/resolve.js';
// Importing the index registers the built-in families as a side effect.
import '../../../../src/model/custom/index.js';
import { recordingWriter, INTERFACE_ID } from './fixtures.js';

const RWE = Operations.READ | Operations.WRITE | Operations.EVENT;

interface SpecOverrides {
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
}

function makeSpec(type: ParameterType, overrides: SpecOverrides = {}): ParameterSpec {
  return {
    type,
    operations: RWE,
    flags: 1,
    readable: true,
    writable: true,
    hasEvents: true,
    visible: true,
    ...(overrides.min !== undefined ? { min: overrides.min } : {}),
    ...(overrides.max !== undefined ? { max: overrides.max } : {}),
    ...(overrides.unit !== undefined ? { unit: overrides.unit } : {}),
  };
}

function makeDp(
  channelAddress: string,
  parameter: string,
  type: ParameterType,
  overrides: SpecOverrides = {},
): GenericDataPoint {
  return new GenericDataPoint({
    dpk: makeDpk(INTERFACE_ID, channelAddress, 'VALUES', parameter),
    spec: makeSpec(type, overrides),
    interfaceFamily: 'HMIP',
  });
}

interface ThermostatDps {
  readonly setpoint: GenericDataPoint;
  readonly temperature: GenericDataPoint;
  readonly humidity: GenericDataPoint;
  readonly setPointMode: GenericDataPoint;
  readonly controlMode: GenericDataPoint;
  readonly boostMode: GenericDataPoint;
  readonly activeProfile: GenericDataPoint;
}

function makeThermostatDps(channel = 'VCU0000010:1'): ThermostatDps {
  const setpoint = makeDp(channel, 'SET_POINT_TEMPERATURE', ParameterType.FLOAT, {
    min: 4.5,
    max: 30.5,
    unit: '°C',
  });
  const temperature = makeDp(channel, 'ACTUAL_TEMPERATURE', ParameterType.FLOAT);
  const humidity = makeDp(channel, 'HUMIDITY', ParameterType.INTEGER);
  const setPointMode = makeDp(channel, 'SET_POINT_MODE', ParameterType.INTEGER);
  const controlMode = makeDp(channel, 'CONTROL_MODE', ParameterType.INTEGER);
  const boostMode = makeDp(channel, 'BOOST_MODE', ParameterType.BOOL);
  const activeProfile = makeDp(channel, 'ACTIVE_PROFILE', ParameterType.INTEGER);
  return { setpoint, temperature, humidity, setPointMode, controlMode, boostMode, activeProfile };
}

function makeClimate(channel = 'VCU0000010:1'): {
  entity: ClimateEntity;
  dps: ThermostatDps;
  calls: ReturnType<typeof recordingWriter>['calls'];
} {
  const { writer, calls } = recordingWriter();
  const dps = makeThermostatDps(channel);
  // Seed initial values.
  dps.setpoint.applyCcuValue(21, 1);
  dps.temperature.applyCcuValue(20.5, 1);
  dps.humidity.applyCcuValue(45, 1);
  dps.setPointMode.applyCcuValue(1, 1);
  dps.boostMode.applyCcuValue(false, 1);
  dps.activeProfile.applyCcuValue(1, 1);

  const dataPoints = new Map<Field, GenericDataPoint>([
    [Field.SETPOINT, dps.setpoint],
    [Field.TEMPERATURE, dps.temperature],
    [Field.HUMIDITY, dps.humidity],
    [Field.SET_POINT_MODE, dps.setPointMode],
    [Field.CONTROL_MODE, dps.controlMode],
    [Field.BOOST_MODE, dps.boostMode],
    [Field.ACTIVE_PROFILE, dps.activeProfile],
  ]);
  const entity = new ClimateEntity({
    deviceAddress: 'VCU0000010',
    primaryChannelAddress: channel,
    type: 'HmIP-eTRV',
    dataPoints,
    writer,
  });
  return { entity, dps, calls };
}

describe('ClimateEntity', () => {
  it('kind is climate', () => {
    expect(makeClimate().entity.kind).toBe('climate');
  });

  it('reads temperatures, humidity, and metadata', () => {
    const { entity } = makeClimate();
    expect(entity.targetTemperature).toBe(21);
    expect(entity.currentTemperature).toBe(20.5);
    expect(entity.currentHumidity).toBe(45);
    expect(entity.minTemp).toBe(4.5);
    expect(entity.maxTemp).toBe(30.5);
    expect(entity.targetTemperatureStep).toBe(0.5);
    expect(entity.temperatureUnit).toBe('°C');
    expect(entity.modes).toEqual(['auto', 'heat', 'off']);
  });

  it('mode is heat when SET_POINT_MODE is 1 (MANU)', () => {
    expect(makeClimate().entity.mode).toBe('heat');
  });

  it('mode is auto when SET_POINT_MODE is 0', () => {
    const { entity, dps } = makeClimate();
    dps.setPointMode.applyCcuValue(0, 2);
    expect(entity.mode).toBe('auto');
  });

  it('mode is off when target temperature <= 4.5', () => {
    const { entity, dps } = makeClimate();
    dps.setpoint.applyCcuValue(4.5, 2);
    expect(entity.mode).toBe('off');
  });

  it('minTemp/maxTemp fall back to 4.5/30.5 when metadata is absent', () => {
    const { writer } = recordingWriter();
    const setpoint = makeDp('VCU0000011:1', 'SET_POINT_TEMPERATURE', ParameterType.FLOAT);
    const entity = new ClimateEntity({
      deviceAddress: 'VCU0000011',
      primaryChannelAddress: 'VCU0000011:1',
      type: 'HmIP-eTRV',
      dataPoints: new Map([[Field.SETPOINT, setpoint]]),
      writer,
    });
    expect(entity.minTemp).toBe(4.5);
    expect(entity.maxTemp).toBe(30.5);
  });

  it('returns null for getters when data points are absent', () => {
    const { writer } = recordingWriter();
    const entity = new ClimateEntity({
      deviceAddress: 'VCU0000012',
      primaryChannelAddress: 'VCU0000012:1',
      type: 'HmIP-eTRV',
      dataPoints: new Map(),
      writer,
    });
    expect(entity.currentTemperature).toBeNull();
    expect(entity.targetTemperature).toBeNull();
    expect(entity.currentHumidity).toBeNull();
  });

  it('setTemperature writes SET_POINT_TEMPERATURE', async () => {
    const { entity, calls } = makeClimate();
    await entity.setTemperature(22);
    expect(calls).toEqual([
      { channelAddress: 'VCU0000010:1', parameter: 'SET_POINT_TEMPERATURE', value: 22 },
    ]);
  });

  it('setTemperature clamps above maxTemp', async () => {
    const { entity, calls } = makeClimate();
    await entity.setTemperature(99);
    expect(calls).toEqual([
      { channelAddress: 'VCU0000010:1', parameter: 'SET_POINT_TEMPERATURE', value: 30.5 },
    ]);
  });

  it('setTemperature clamps below minTemp', async () => {
    const { entity, calls } = makeClimate();
    await entity.setTemperature(0);
    expect(calls).toEqual([
      { channelAddress: 'VCU0000010:1', parameter: 'SET_POINT_TEMPERATURE', value: 4.5 },
    ]);
  });

  it("setMode('auto') writes CONTROL_MODE=0", async () => {
    const { entity, calls } = makeClimate();
    await entity.setMode('auto');
    expect(calls).toEqual([
      { channelAddress: 'VCU0000010:1', parameter: 'CONTROL_MODE', value: 0 },
    ]);
  });

  it("setMode('heat') writes CONTROL_MODE=1", async () => {
    const { entity, calls } = makeClimate();
    await entity.setMode('heat');
    expect(calls).toEqual([
      { channelAddress: 'VCU0000010:1', parameter: 'CONTROL_MODE', value: 1 },
    ]);
  });

  it("setMode('off') writes CONTROL_MODE=1 then SET_POINT_TEMPERATURE=4.5", async () => {
    const { entity, calls } = makeClimate();
    await entity.setMode('off');
    expect(calls).toEqual([
      { channelAddress: 'VCU0000010:1', parameter: 'CONTROL_MODE', value: 1 },
      { channelAddress: 'VCU0000010:1', parameter: 'SET_POINT_TEMPERATURE', value: 4.5 },
    ]);
  });

  it('setBoost writes BOOST_MODE', async () => {
    const { entity, calls } = makeClimate();
    await entity.setBoost(true);
    expect(calls).toEqual([
      { channelAddress: 'VCU0000010:1', parameter: 'BOOST_MODE', value: true },
    ]);
  });

  it('setProfile writes ACTIVE_PROFILE', async () => {
    const { entity, calls } = makeClimate();
    await entity.setProfile(3);
    expect(calls).toEqual([
      { channelAddress: 'VCU0000010:1', parameter: 'ACTIVE_PROFILE', value: 3 },
    ]);
  });

  it('preset is boost when BOOST_MODE is true', () => {
    const { entity, dps } = makeClimate();
    dps.boostMode.applyCcuValue(true, 2);
    expect(entity.preset).toBe('boost');
  });

  it('preset is away when SET_POINT_MODE is 2', () => {
    const { entity, dps } = makeClimate();
    dps.setPointMode.applyCcuValue(2, 2);
    expect(entity.preset).toBe('away');
  });

  it('preset is week_program when a profile is active', () => {
    const { entity } = makeClimate();
    expect(entity.preset).toBe('week_program');
  });

  it('preset is none when no profile is active', () => {
    const { entity, dps } = makeClimate();
    dps.activeProfile.applyCcuValue(0, 2);
    expect(entity.preset).toBe('none');
  });

  it('activity is idle by default and off when mode is off', () => {
    const { entity, dps } = makeClimate();
    // No LEVEL/STATE → idle.
    expect(entity.activity).toBe('idle');
    dps.setpoint.applyCcuValue(4.5, 2);
    expect(entity.activity).toBe('off');
  });

  it('setTemperature throws when SETPOINT data point is absent', async () => {
    const { writer } = recordingWriter();
    const entity = new ClimateEntity({
      deviceAddress: 'VCU0000013',
      primaryChannelAddress: 'VCU0000013:1',
      type: 'HmIP-eTRV',
      dataPoints: new Map(),
      writer,
    });
    await expect(entity.setTemperature(20)).rejects.toThrow();
  });
});

describe('Climate heating group (HmIP-HEATING)', () => {
  it('resolves a ClimateEntity with LEVEL on ch1 and STATE on ch4', () => {
    // Group profile: primary fields on base channel 1, channelFields offset 0 → LEVEL (abs ch1),
    // offset 3 → STATE (abs ch4).
    const setpoint = makeDp('VCU0000099:1', 'SET_POINT_TEMPERATURE', ParameterType.FLOAT, {
      min: 4.5,
      max: 30.5,
    });
    const temperature = makeDp('VCU0000099:1', 'ACTUAL_TEMPERATURE', ParameterType.FLOAT);
    const humidity = makeDp('VCU0000099:1', 'HUMIDITY', ParameterType.INTEGER);
    const setPointMode = makeDp('VCU0000099:1', 'SET_POINT_MODE', ParameterType.INTEGER);
    const controlMode = makeDp('VCU0000099:1', 'CONTROL_MODE', ParameterType.INTEGER);
    const boostMode = makeDp('VCU0000099:1', 'BOOST_MODE', ParameterType.BOOL);
    const activeProfile = makeDp('VCU0000099:1', 'ACTIVE_PROFILE', ParameterType.INTEGER);
    const level = makeDp('VCU0000099:1', 'LEVEL', ParameterType.FLOAT);
    const state = makeDp('VCU0000099:4', 'STATE', ParameterType.BOOL);

    setpoint.applyCcuValue(22, 1);
    temperature.applyCcuValue(21, 1);
    setPointMode.applyCcuValue(1, 1);
    level.applyCcuValue(0.5, 1);

    const ch1 = new ModelChannel({
      address: 'VCU0000099:1',
      index: 1,
      dataPoints: [
        setpoint,
        temperature,
        humidity,
        setPointMode,
        controlMode,
        boostMode,
        activeProfile,
        level,
      ],
    });
    const ch4 = new ModelChannel({ address: 'VCU0000099:4', index: 4, dataPoints: [state] });
    const device = new ModelDevice({
      address: 'VCU0000099',
      type: 'HmIP-HEATING',
      interfaceId: INTERFACE_ID,
      channels: [ch1, ch4],
    });

    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    const entity = entities[0];
    expect(entity).toBeInstanceOf(ClimateEntity);
    expect(entity?.primaryChannelAddress).toBe('VCU0000099:1');

    const climate = entity as ClimateEntity;
    expect(climate.targetTemperature).toBe(22);
    expect(climate.currentTemperature).toBe(21);
    expect(climate.mode).toBe('heat');
    // LEVEL > 0 → heating.
    expect(climate.activity).toBe('heating');
  });

  it('activity is heating from STATE=true when LEVEL is 0', () => {
    const setpoint = makeDp('VCU0000098:1', 'SET_POINT_TEMPERATURE', ParameterType.FLOAT);
    const level = makeDp('VCU0000098:1', 'LEVEL', ParameterType.FLOAT);
    const state = makeDp('VCU0000098:4', 'STATE', ParameterType.BOOL);
    setpoint.applyCcuValue(21, 1);
    level.applyCcuValue(0, 1);
    state.applyCcuValue(true, 1);

    const ch1 = new ModelChannel({
      address: 'VCU0000098:1',
      index: 1,
      dataPoints: [setpoint, level],
    });
    const ch4 = new ModelChannel({ address: 'VCU0000098:4', index: 4, dataPoints: [state] });
    const device = new ModelDevice({
      address: 'VCU0000098',
      type: 'HmIP-HEATING',
      interfaceId: INTERFACE_ID,
      channels: [ch1, ch4],
    });
    const { writer } = recordingWriter();
    const [entity] = buildCustomEntities(device, writer);
    expect((entity as ClimateEntity).activity).toBe('heating');
  });
});

describe('Climate registry', () => {
  it('resolves exactly one ClimateEntity for HmIP-STHD (no prefix duplication)', () => {
    const setpoint = makeDp('VCU0000060:1', 'SET_POINT_TEMPERATURE', ParameterType.FLOAT);
    setpoint.applyCcuValue(21, 1);
    const ch1 = new ModelChannel({
      address: 'VCU0000060:1',
      index: 1,
      dataPoints: [setpoint],
    });
    const device = new ModelDevice({
      address: 'VCU0000060',
      type: 'HmIP-STHD',
      interfaceId: INTERFACE_ID,
      channels: [ch1],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(ClimateEntity);
  });

  it('does not register HmIP-FALMOT as a climate entity', () => {
    const setpoint = makeDp('VCU0000050:1', 'SET_POINT_TEMPERATURE', ParameterType.FLOAT);
    const ch1 = new ModelChannel({
      address: 'VCU0000050:1',
      index: 1,
      dataPoints: [setpoint],
    });
    const device = new ModelDevice({
      address: 'VCU0000050',
      type: 'HmIP-FALMOT-C12',
      interfaceId: INTERFACE_ID,
      channels: [ch1],
    });
    const { writer } = recordingWriter();
    // FALMOT stays generic — no ClimateEntity, no crash.
    expect(buildCustomEntities(device, writer)).toEqual([]);
  });
});
