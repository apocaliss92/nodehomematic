import { describe, it, expect, vi } from 'vitest';
import { GenericDataPoint } from '../../../src/model/data-point.js';
import type { ParameterSpec } from '../../../src/central/graph.js';
import { makeDpk, dpkToUniqueId, type DataPointKey } from '../../../src/support/dpk.js';
import { ParameterType, Operations } from '../../../src/support/constants.js';
import { UnsupportedError } from '../../../src/support/errors.js';

const RWE = Operations.READ | Operations.WRITE | Operations.EVENT;

function makeSpec(overrides: Partial<ParameterSpec> & { type: ParameterType }): ParameterSpec {
  const operations = overrides.operations ?? RWE;
  return {
    type: overrides.type,
    operations,
    flags: overrides.flags ?? 1,
    readable: (operations & Operations.READ) !== 0,
    writable: (operations & Operations.WRITE) !== 0,
    hasEvents: (operations & Operations.EVENT) !== 0,
    visible: true,
    ...(overrides.min !== undefined ? { min: overrides.min } : {}),
    ...(overrides.max !== undefined ? { max: overrides.max } : {}),
    ...(overrides.unit !== undefined ? { unit: overrides.unit } : {}),
    ...(overrides.valueList !== undefined ? { valueList: overrides.valueList } : {}),
  };
}

function makeDp(
  spec: ParameterSpec,
  interfaceFamily: 'HM' | 'HMIP' = 'HM',
  dpk: DataPointKey = makeDpk('MyCCU-BidCos-RF', 'VCU0000001:1', 'VALUES', 'STATE'),
): GenericDataPoint {
  return new GenericDataPoint({ dpk, spec, interfaceFamily });
}

describe('GenericDataPoint getters', () => {
  it('exposes id, dpk, parameter and spec-derived metadata', () => {
    const dpk = makeDpk('MyCCU-BidCos-RF', 'VCU0000001:1', 'VALUES', 'LEVEL');
    const spec = makeSpec({
      type: ParameterType.FLOAT,
      min: 0,
      max: 100,
      unit: '%',
    });
    const dp = makeDp(spec, 'HM', dpk);

    expect(dp.id).toBe(dpkToUniqueId(dpk));
    expect(dp.dpk).toEqual(dpk);
    expect(dp.parameter).toBe('LEVEL');
    expect(dp.type).toBe(ParameterType.FLOAT);
    expect(dp.readable).toBe(true);
    expect(dp.writable).toBe(true);
    expect(dp.hasEvents).toBe(true);
    expect(dp.visible).toBe(true);
    expect(dp.unit).toBe('%');
    expect(dp.min).toBe(0);
    expect(dp.max).toBe(100);
  });

  it('exposes valueList for ENUM', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON'] }));
    expect(dp.valueList).toEqual(['OFF', 'ON']);
  });

  it('reflects spec operations (read-only)', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.FLOAT, operations: Operations.READ }));
    expect(dp.readable).toBe(true);
    expect(dp.writable).toBe(false);
    expect(dp.hasEvents).toBe(false);
  });

  it('starts with null value and undefined lastUpdatedAt', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.FLOAT }));
    expect(dp.value).toBeNull();
    expect(dp.lastUpdatedAt).toBeUndefined();
  });
});

describe('applyCcuValue', () => {
  it('updates value + lastUpdatedAt and reports changed/prev/next', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.FLOAT }));
    const res = dp.applyCcuValue('21.5', 1000);
    expect(res).toEqual({ changed: true, prev: null, next: 21.5 });
    expect(dp.value).toBe(21.5);
    expect(dp.lastUpdatedAt).toBe(1000);
  });

  it('reports changed=false when the converted value is unchanged', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.FLOAT }));
    dp.applyCcuValue('5', 1000);
    const res = dp.applyCcuValue(5, 2000);
    expect(res).toEqual({ changed: false, prev: 5, next: 5 });
    // timestamp still advances even when value is unchanged
    expect(dp.lastUpdatedAt).toBe(2000);
  });

  it('maps ENUM index to value-list string', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON', 'AUTO'] }));
    const res = dp.applyCcuValue(2, 1);
    expect(res.next).toBe('AUTO');
    expect(dp.value).toBe('AUTO');
  });

  it('notifies subscribers only when the value changes', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.FLOAT }));
    const cb = vi.fn();
    dp.subscribe(cb);

    dp.applyCcuValue(1, 10);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(1, null);

    // Same value → no notification.
    dp.applyCcuValue(1, 20);
    expect(cb).toHaveBeenCalledTimes(1);

    dp.applyCcuValue(2, 30);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(2, 1);
  });

  it('unsubscribe stops notifications', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.FLOAT }));
    const cb = vi.fn();
    const off = dp.subscribe(cb);
    off();
    dp.applyCcuValue(1, 10);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('prepareWrite', () => {
  it('HM enum → integer index', () => {
    const dp = makeDp(
      makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON', 'AUTO'] }),
      'HM',
    );
    expect(dp.prepareWrite('AUTO')).toBe(2);
  });

  it('HMIP enum → string', () => {
    const dp = makeDp(
      makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON', 'AUTO'] }),
      'HMIP',
    );
    expect(dp.prepareWrite('AUTO')).toBe('AUTO');
    // numeric index resolves to the string in HMIP mode
    expect(dp.prepareWrite(1)).toBe('ON');
  });

  it('validates + converts numeric writes', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.FLOAT, min: 0, max: 10 }));
    expect(dp.prepareWrite(5)).toBe(5);
  });

  it('throws UnsupportedError on a non-writable data point', () => {
    const dp = makeDp(makeSpec({ type: ParameterType.FLOAT, operations: Operations.READ }));
    expect(() => dp.prepareWrite(5)).toThrow(UnsupportedError);
  });
});
