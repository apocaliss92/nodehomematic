import { describe, it, expect } from 'vitest';
import { ModelChannel } from '../../../src/model/channel.js';
import { GenericDataPoint } from '../../../src/model/data-point.js';
import type { ParameterSpec } from '../../../src/central/graph.js';
import { makeDpk } from '../../../src/support/dpk.js';
import { ParameterType, Operations } from '../../../src/support/constants.js';

const RWE = Operations.READ | Operations.WRITE | Operations.EVENT;

function makeSpec(type: ParameterType): ParameterSpec {
  return {
    type,
    operations: RWE,
    flags: 1,
    readable: true,
    writable: true,
    hasEvents: true,
    visible: true,
  };
}

function makeDp(parameter: string, type: ParameterType): GenericDataPoint {
  return new GenericDataPoint({
    dpk: makeDpk('MyCCU-BidCos-RF', 'VCU0000001:1', 'VALUES', parameter),
    spec: makeSpec(type),
    interfaceFamily: 'HM',
  });
}

describe('ModelChannel', () => {
  it('exposes address, index, type and data points', () => {
    const dps = [makeDp('STATE', ParameterType.BOOL), makeDp('LEVEL', ParameterType.FLOAT)];
    const channel = new ModelChannel({
      address: 'VCU0000001:1',
      index: 1,
      type: 'SWITCH',
      dataPoints: dps,
    });

    expect(channel.address).toBe('VCU0000001:1');
    expect(channel.index).toBe(1);
    expect(channel.type).toBe('SWITCH');
    expect(channel.dataPoints).toHaveLength(2);
  });

  it('resolves a data point by parameter name', () => {
    const dps = [makeDp('STATE', ParameterType.BOOL), makeDp('LEVEL', ParameterType.FLOAT)];
    const channel = new ModelChannel({ address: 'VCU0000001:1', index: 1, dataPoints: dps });

    expect(channel.dataPoint('STATE')?.parameter).toBe('STATE');
    expect(channel.dataPoint('LEVEL')?.parameter).toBe('LEVEL');
  });

  it('returns undefined for an unknown parameter', () => {
    const channel = new ModelChannel({
      address: 'VCU0000001:1',
      index: 1,
      dataPoints: [makeDp('STATE', ParameterType.BOOL)],
    });
    expect(channel.dataPoint('NOPE')).toBeUndefined();
  });

  it('allows an absent type', () => {
    const channel = new ModelChannel({ address: 'VCU0000001:0', index: 0, dataPoints: [] });
    expect(channel.type).toBeUndefined();
    expect(channel.dataPoints).toEqual([]);
  });
});
