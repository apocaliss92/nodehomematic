import { describe, it, expect } from 'vitest';
import { DimmerEntity } from '../../../../src/model/custom/light.js';
import { Field } from '../../../../src/model/custom/fields.js';
import { GenericDataPoint } from '../../../../src/model/data-point.js';
import { ModelDevice } from '../../../../src/model/device.js';
import { ModelChannel } from '../../../../src/model/channel.js';
import { ParameterType } from '../../../../src/support/constants.js';
import { buildCustomEntities } from '../../../../src/model/custom/resolve.js';
// Importing the index registers the built-in families as a side effect.
import '../../../../src/model/custom/index.js';
import { makeDp, recordingWriter, INTERFACE_ID } from './fixtures.js';

function makeDimmer(channel = 'VCU0000020:4'): {
  entity: DimmerEntity;
  level: GenericDataPoint;
  calls: ReturnType<typeof recordingWriter>['calls'];
} {
  const { writer, calls } = recordingWriter();
  const level = makeDp(channel, 'LEVEL', ParameterType.FLOAT);
  const dataPoints = new Map<Field, GenericDataPoint>([[Field.LEVEL, level]]);
  const entity = new DimmerEntity({
    deviceAddress: 'VCU0000020',
    primaryChannelAddress: channel,
    type: 'HmIP-BDT',
    dataPoints,
    writer,
  });
  return { entity, level, calls };
}

describe('DimmerEntity', () => {
  it('kind is light', () => {
    expect(makeDimmer().entity.kind).toBe('light');
  });

  it('brightness is null until LEVEL has a value', () => {
    expect(makeDimmer().entity.brightness).toBeNull();
  });

  it('brightness reflects LEVEL (0.5 → ~128) and isOn is true', () => {
    const { entity, level } = makeDimmer();
    level.applyCcuValue(0.5, 1);
    expect(entity.brightness).toBe(128);
    expect(entity.isOn).toBe(true);
  });

  it('isOn is false when LEVEL is 0', () => {
    const { entity, level } = makeDimmer();
    level.applyCcuValue(0, 1);
    expect(entity.brightness).toBe(0);
    expect(entity.isOn).toBe(false);
  });

  it('turnOn(default) writes LEVEL=1', async () => {
    const { entity, calls } = makeDimmer();
    await entity.turnOn();
    expect(calls).toEqual([{ channelAddress: 'VCU0000020:4', parameter: 'LEVEL', value: 1 }]);
  });

  it('turnOn(brightness) writes the converted LEVEL', async () => {
    const { entity, calls } = makeDimmer();
    await entity.turnOn(128);
    expect(calls).toEqual([
      { channelAddress: 'VCU0000020:4', parameter: 'LEVEL', value: 128 / 255 },
    ]);
  });

  it('turnOff writes LEVEL=0', async () => {
    const { entity, calls } = makeDimmer();
    await entity.turnOff();
    expect(calls).toEqual([{ channelAddress: 'VCU0000020:4', parameter: 'LEVEL', value: 0 }]);
  });

  it('setBrightness(255) writes LEVEL=1', async () => {
    const { entity, calls } = makeDimmer();
    await entity.setBrightness(255);
    expect(calls).toEqual([{ channelAddress: 'VCU0000020:4', parameter: 'LEVEL', value: 1 }]);
  });
});

describe('Dimmer registry', () => {
  it('resolves a DimmerEntity for HmIP-BDT (channel 4)', () => {
    const level = makeDp('VCU0000021:4', 'LEVEL', ParameterType.FLOAT);
    level.applyCcuValue(0.5, 1);
    const ch4 = new ModelChannel({ address: 'VCU0000021:4', index: 4, dataPoints: [level] });
    const device = new ModelDevice({
      address: 'VCU0000021',
      type: 'HmIP-BDT',
      interfaceId: INTERFACE_ID,
      channels: [ch4],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(DimmerEntity);
    expect(entities[0]?.kind).toBe('light');
  });

  it('resolves a DimmerEntity for HM-LC-Dim (RF, channel 1)', () => {
    const level = makeDp('VCU0000022:1', 'LEVEL', ParameterType.FLOAT);
    const ch1 = new ModelChannel({ address: 'VCU0000022:1', index: 1, dataPoints: [level] });
    const device = new ModelDevice({
      address: 'VCU0000022',
      type: 'HM-LC-Dim1T-Pl',
      interfaceId: INTERFACE_ID,
      channels: [ch1],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(DimmerEntity);
  });
});
