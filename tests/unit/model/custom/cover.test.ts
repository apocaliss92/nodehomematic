import { describe, it, expect } from 'vitest';
import { CoverEntity, BlindEntity } from '../../../../src/model/custom/cover.js';
import { Field } from '../../../../src/model/custom/fields.js';
import { GenericDataPoint } from '../../../../src/model/data-point.js';
import { ModelDevice } from '../../../../src/model/device.js';
import { ModelChannel } from '../../../../src/model/channel.js';
import { ParameterType } from '../../../../src/support/constants.js';
import { buildCustomEntities } from '../../../../src/model/custom/resolve.js';
// Importing the index registers the built-in families as a side effect.
import '../../../../src/model/custom/index.js';
import { makeDp, recordingWriter, INTERFACE_ID } from './fixtures.js';

function makeCover(channel = 'VCU0000030:4'): {
  entity: CoverEntity;
  level: GenericDataPoint;
  stop: GenericDataPoint;
  direction: GenericDataPoint;
  calls: ReturnType<typeof recordingWriter>['calls'];
} {
  const { writer, calls } = recordingWriter();
  const level = makeDp(channel, 'LEVEL', ParameterType.FLOAT);
  const stop = makeDp(channel, 'STOP', ParameterType.ACTION);
  const direction = makeDp(channel, 'ACTIVITY_STATE', ParameterType.ENUM);
  const dataPoints = new Map<Field, GenericDataPoint>([
    [Field.LEVEL, level],
    [Field.STOP, stop],
    [Field.DIRECTION, direction],
  ]);
  const entity = new CoverEntity({
    deviceAddress: 'VCU0000030',
    primaryChannelAddress: channel,
    type: 'HmIP-BROLL',
    dataPoints,
    writer,
  });
  return { entity, level, stop, direction, calls };
}

describe('CoverEntity', () => {
  it('kind is cover', () => {
    expect(makeCover().entity.kind).toBe('cover');
  });

  it('currentPosition is null until LEVEL has a value', () => {
    expect(makeCover().entity.currentPosition).toBeNull();
  });

  it('currentPosition reflects LEVEL (0.5 → 50)', () => {
    const { entity, level } = makeCover();
    level.applyCcuValue(0.5, 1);
    expect(entity.currentPosition).toBe(50);
  });

  it('isClosed is true when LEVEL is 0', () => {
    const { entity, level } = makeCover();
    level.applyCcuValue(0, 1);
    expect(entity.isClosed).toBe(true);
    level.applyCcuValue(0.5, 2);
    expect(entity.isClosed).toBe(false);
  });

  it('isOpening/isClosing reflect DIRECTION', () => {
    const { entity, direction } = makeCover();
    expect(entity.isOpening).toBe(false);
    expect(entity.isClosing).toBe(false);
    direction.applyCcuValue('UP', 1);
    expect(entity.isOpening).toBe(true);
    expect(entity.isClosing).toBe(false);
    direction.applyCcuValue('DOWN', 2);
    expect(entity.isOpening).toBe(false);
    expect(entity.isClosing).toBe(true);
  });

  it('open writes LEVEL=1', async () => {
    const { entity, calls } = makeCover();
    await entity.open();
    expect(calls).toEqual([{ channelAddress: 'VCU0000030:4', parameter: 'LEVEL', value: 1 }]);
  });

  it('close writes LEVEL=0', async () => {
    const { entity, calls } = makeCover();
    await entity.close();
    expect(calls).toEqual([{ channelAddress: 'VCU0000030:4', parameter: 'LEVEL', value: 0 }]);
  });

  it('stop writes STOP=true', async () => {
    const { entity, calls } = makeCover();
    await entity.stop();
    expect(calls).toEqual([{ channelAddress: 'VCU0000030:4', parameter: 'STOP', value: true }]);
  });

  it('setPosition(25) writes LEVEL=0.25', async () => {
    const { entity, calls } = makeCover();
    await entity.setPosition(25);
    expect(calls).toEqual([{ channelAddress: 'VCU0000030:4', parameter: 'LEVEL', value: 0.25 }]);
  });
});

function makeBlind(channel = 'VCU0000031:4'): {
  entity: BlindEntity;
  level: GenericDataPoint;
  level2: GenericDataPoint;
  calls: ReturnType<typeof recordingWriter>['calls'];
} {
  const { writer, calls } = recordingWriter();
  const level = makeDp(channel, 'LEVEL', ParameterType.FLOAT);
  const level2 = makeDp(channel, 'LEVEL_2', ParameterType.FLOAT);
  const stop = makeDp(channel, 'STOP', ParameterType.ACTION);
  const direction = makeDp(channel, 'ACTIVITY_STATE', ParameterType.ENUM);
  const dataPoints = new Map<Field, GenericDataPoint>([
    [Field.LEVEL, level],
    [Field.LEVEL_2, level2],
    [Field.STOP, stop],
    [Field.DIRECTION, direction],
  ]);
  const entity = new BlindEntity({
    deviceAddress: 'VCU0000031',
    primaryChannelAddress: channel,
    type: 'HmIP-BBL',
    dataPoints,
    writer,
  });
  return { entity, level, level2, calls };
}

describe('BlindEntity', () => {
  it('kind is blind', () => {
    expect(makeBlind().entity.kind).toBe('blind');
  });

  it('currentTiltPosition reflects LEVEL_2 (0.3 → 30)', () => {
    const { entity, level2 } = makeBlind();
    expect(entity.currentTiltPosition).toBeNull();
    level2.applyCcuValue(0.3, 1);
    expect(entity.currentTiltPosition).toBe(30);
  });

  it('setPosition(pos) writes only LEVEL', async () => {
    const { entity, calls } = makeBlind();
    await entity.setPosition(40);
    expect(calls).toEqual([{ channelAddress: 'VCU0000031:4', parameter: 'LEVEL', value: 0.4 }]);
  });

  it('setPosition(pos, tilt) writes LEVEL then LEVEL_2', async () => {
    const { entity, calls } = makeBlind();
    await entity.setPosition(40, 60);
    expect(calls).toEqual([
      { channelAddress: 'VCU0000031:4', parameter: 'LEVEL', value: 0.4 },
      { channelAddress: 'VCU0000031:4', parameter: 'LEVEL_2', value: 0.6 },
    ]);
  });
});

describe('Cover/Blind registry', () => {
  it('resolves a CoverEntity for HmIP-BROLL (channel 4)', () => {
    const level = makeDp('VCU0000032:4', 'LEVEL', ParameterType.FLOAT);
    const stop = makeDp('VCU0000032:4', 'STOP', ParameterType.ACTION);
    const ch4 = new ModelChannel({ address: 'VCU0000032:4', index: 4, dataPoints: [level, stop] });
    const device = new ModelDevice({
      address: 'VCU0000032',
      type: 'HmIP-BROLL',
      interfaceId: INTERFACE_ID,
      channels: [ch4],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(CoverEntity);
    expect(entities[0]?.kind).toBe('cover');
  });

  it('resolves a BlindEntity for HmIP-BBL (channel 4)', () => {
    const level = makeDp('VCU0000033:4', 'LEVEL', ParameterType.FLOAT);
    const level2 = makeDp('VCU0000033:4', 'LEVEL_2', ParameterType.FLOAT);
    const stop = makeDp('VCU0000033:4', 'STOP', ParameterType.ACTION);
    const ch4 = new ModelChannel({
      address: 'VCU0000033:4',
      index: 4,
      dataPoints: [level, level2, stop],
    });
    const device = new ModelDevice({
      address: 'VCU0000033',
      type: 'HmIP-BBL',
      interfaceId: INTERFACE_ID,
      channels: [ch4],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(BlindEntity);
    expect(entities[0]?.kind).toBe('blind');
  });

  it('resolves a CoverEntity for HM-LC-Bl1 (RF, channel 1)', () => {
    const level = makeDp('VCU0000034:1', 'LEVEL', ParameterType.FLOAT);
    const stop = makeDp('VCU0000034:1', 'STOP', ParameterType.ACTION);
    const direction = makeDp('VCU0000034:1', 'DIRECTION', ParameterType.ENUM);
    const ch1 = new ModelChannel({
      address: 'VCU0000034:1',
      index: 1,
      dataPoints: [level, stop, direction],
    });
    const device = new ModelDevice({
      address: 'VCU0000034',
      type: 'HM-LC-Bl1-FM',
      interfaceId: INTERFACE_ID,
      channels: [ch1],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(CoverEntity);
  });

  it('reads DIRECTION via the RF DIRECTION parameter', () => {
    const level = makeDp('VCU0000035:1', 'LEVEL', ParameterType.FLOAT);
    const direction = makeDp('VCU0000035:1', 'DIRECTION', ParameterType.ENUM);
    direction.applyCcuValue('UP', 1);
    const ch1 = new ModelChannel({
      address: 'VCU0000035:1',
      index: 1,
      dataPoints: [level, direction],
    });
    const device = new ModelDevice({
      address: 'VCU0000035',
      type: 'HM-LC-Bl1-FM',
      interfaceId: INTERFACE_ID,
      channels: [ch1],
    });
    const { writer } = recordingWriter();
    const [entity] = buildCustomEntities(device, writer);
    expect((entity as CoverEntity).isOpening).toBe(true);
  });
});
