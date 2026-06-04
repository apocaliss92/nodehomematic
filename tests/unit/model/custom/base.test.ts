import { describe, it, expect, vi } from 'vitest';
import { CustomEntity } from '../../../../src/model/custom/base.js';
import { Field } from '../../../../src/model/custom/fields.js';
import { GenericDataPoint } from '../../../../src/model/data-point.js';
import { DescriptionNotFoundError } from '../../../../src/support/errors.js';
import { ParameterType } from '../../../../src/support/constants.js';
import { makeDp, recordingWriter } from './fixtures.js';

class TestEntity extends CustomEntity {
  public readonly kind = 'test';
  public callDp(field: Field): GenericDataPoint | undefined {
    return this.dp(field);
  }
  public callRequireDp(field: Field): GenericDataPoint {
    return this.requireDp(field);
  }
  public callWrite(field: Field, value: boolean): Promise<void> {
    return this.write(field, value);
  }
}

function makeEntity(withState = true) {
  const { writer, calls } = recordingWriter();
  const dataPoints = new Map<Field, GenericDataPoint>();
  if (withState) {
    dataPoints.set(Field.STATE, makeDp('VCU0000001:3', 'STATE', ParameterType.BOOL));
  }
  const entity = new TestEntity({
    deviceAddress: 'VCU0000001',
    primaryChannelAddress: 'VCU0000001:3',
    type: 'HmIP-PS',
    dataPoints,
    writer,
  });
  return { entity, calls };
}

describe('CustomEntity base', () => {
  it('exposes identity fields', () => {
    const { entity } = makeEntity();
    expect(entity.deviceAddress).toBe('VCU0000001');
    expect(entity.primaryChannelAddress).toBe('VCU0000001:3');
    expect(entity.type).toBe('HmIP-PS');
    expect(entity.kind).toBe('test');
  });

  it('dp returns the resolved data point or undefined', () => {
    const { entity } = makeEntity();
    expect(entity.callDp(Field.STATE)?.parameter).toBe('STATE');
    expect(entity.callDp(Field.LEVEL)).toBeUndefined();
  });

  it('requireDp throws DescriptionNotFoundError for a missing field', () => {
    const { entity } = makeEntity();
    expect(() => entity.callRequireDp(Field.LEVEL)).toThrow(DescriptionNotFoundError);
  });

  it('available reflects whether any data point was resolved', () => {
    expect(makeEntity(true).entity.available).toBe(true);
    expect(makeEntity(false).entity.available).toBe(false);
  });

  it('write routes to the writer with the dp channel address and parameter', async () => {
    const { entity, calls } = makeEntity();
    await entity.callWrite(Field.STATE, true);
    expect(calls).toEqual([{ channelAddress: 'VCU0000001:3', parameter: 'STATE', value: true }]);
  });

  it('write throws when the field is absent', async () => {
    const { entity } = makeEntity();
    await expect(entity.callWrite(Field.LEVEL, true)).rejects.toThrow(DescriptionNotFoundError);
  });

  it('subscribe forwards underlying data-point changes and unsubscribes all', () => {
    const { writer } = recordingWriter();
    const state = makeDp('VCU0000001:3', 'STATE', ParameterType.BOOL);
    const dataPoints = new Map<Field, GenericDataPoint>([[Field.STATE, state]]);
    const entity = new TestEntity({
      deviceAddress: 'VCU0000001',
      primaryChannelAddress: 'VCU0000001:3',
      type: 'HmIP-PS',
      dataPoints,
      writer,
    });
    const cb = vi.fn();
    const unsubscribe = entity.subscribe(cb);

    state.applyCcuValue(true, 1);
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    state.applyCcuValue(false, 2);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
