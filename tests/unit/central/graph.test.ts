import { describe, it, expect } from 'vitest';
import { parameterSpecFromData } from '../../../src/central/graph.js';
import { Operations, Flag, ParameterType } from '../../../src/support/constants.js';
import type { ParameterData } from '../../../src/transport/xmlrpc/types.js';

describe('central/graph parameterSpecFromData', () => {
  it('maps raw ParameterData fields onto the spec', () => {
    const data: ParameterData = {
      TYPE: 'FLOAT',
      OPERATIONS: Operations.READ | Operations.WRITE | Operations.EVENT,
      FLAGS: Flag.VISIBLE,
      MIN: 0,
      MAX: 100,
      DEFAULT: 20,
      UNIT: '°C',
      VALUE_LIST: ['OFF', 'ON'],
      SPECIAL: [{ ID: 'NOT_USED', VALUE: -1 }],
    };
    const spec = parameterSpecFromData(data);
    expect(spec.type).toBe(ParameterType.FLOAT);
    expect(spec.operations).toBe(7);
    expect(spec.flags).toBe(Flag.VISIBLE);
    expect(spec.min).toBe(0);
    expect(spec.max).toBe(100);
    expect(spec.default).toBe(20);
    expect(spec.unit).toBe('°C');
    expect(spec.valueList).toEqual(['OFF', 'ON']);
    expect(spec.special).toEqual([{ ID: 'NOT_USED', VALUE: -1 }]);
  });

  it('computes readable/writable/hasEvents/visible from operations and flags', () => {
    const readOnly = parameterSpecFromData({ TYPE: 'BOOL', OPERATIONS: Operations.READ, FLAGS: 0 });
    expect(readOnly.readable).toBe(true);
    expect(readOnly.writable).toBe(false);
    expect(readOnly.hasEvents).toBe(false);
    expect(readOnly.visible).toBe(false);

    const all = parameterSpecFromData({
      TYPE: 'ACTION',
      OPERATIONS: Operations.READ | Operations.WRITE | Operations.EVENT,
      FLAGS: Flag.VISIBLE,
    });
    expect(all.readable).toBe(true);
    expect(all.writable).toBe(true);
    expect(all.hasEvents).toBe(true);
    expect(all.visible).toBe(true);
  });

  it('defaults missing OPERATIONS/FLAGS to 0 and unknown TYPE to EMPTY', () => {
    const spec = parameterSpecFromData({ TYPE: 'WAT' });
    expect(spec.operations).toBe(0);
    expect(spec.flags).toBe(0);
    expect(spec.readable).toBe(false);
    expect(spec.visible).toBe(false);
    expect(spec.type).toBe(ParameterType.EMPTY);
  });

  it('omits optional fields when absent', () => {
    const spec = parameterSpecFromData({ TYPE: 'BOOL', OPERATIONS: 1, FLAGS: 1 });
    expect(spec.min).toBeUndefined();
    expect(spec.unit).toBeUndefined();
    expect(spec.valueList).toBeUndefined();
  });
});
