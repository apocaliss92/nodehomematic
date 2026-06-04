import { describe, it, expect } from 'vitest';
import { ModelDevice } from '../../../src/model/device.js';
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

function makeDp(channelAddress: string, parameter: string, type: ParameterType): GenericDataPoint {
  return new GenericDataPoint({
    dpk: makeDpk('MyCCU-BidCos-RF', channelAddress, 'VALUES', parameter),
    spec: makeSpec(type),
    interfaceFamily: 'HM',
  });
}

function makeDevice(): ModelDevice {
  const ch0 = new ModelChannel({ address: 'VCU0000001:0', index: 0, dataPoints: [] });
  const ch1 = new ModelChannel({
    address: 'VCU0000001:1',
    index: 1,
    type: 'SWITCH',
    dataPoints: [
      makeDp('VCU0000001:1', 'STATE', ParameterType.BOOL),
      makeDp('VCU0000001:1', 'LEVEL', ParameterType.FLOAT),
    ],
  });
  return new ModelDevice({
    address: 'VCU0000001',
    type: 'HM-LC-Sw1-Pl',
    interfaceId: 'MyCCU-BidCos-RF',
    name: 'Kitchen switch',
    rooms: ['Kitchen'],
    functions: ['Light'],
    channels: [ch0, ch1],
  });
}

describe('ModelDevice', () => {
  it('exposes address, type, interfaceId and metadata', () => {
    const device = makeDevice();
    expect(device.address).toBe('VCU0000001');
    expect(device.type).toBe('HM-LC-Sw1-Pl');
    expect(device.interfaceId).toBe('MyCCU-BidCos-RF');
    expect(device.name).toBe('Kitchen switch');
    expect(device.rooms).toEqual(['Kitchen']);
    expect(device.functions).toEqual(['Light']);
    expect(device.channels).toHaveLength(2);
  });

  it('resolves a channel by address', () => {
    const device = makeDevice();
    expect(device.channel('VCU0000001:1')?.index).toBe(1);
    expect(device.channel('VCU0000001:0')?.index).toBe(0);
    expect(device.channel('VCU0000001:9')).toBeUndefined();
  });

  it('resolves a data point by channel address + parameter', () => {
    const device = makeDevice();
    expect(device.dataPoint('VCU0000001:1', 'STATE')?.parameter).toBe('STATE');
    expect(device.dataPoint('VCU0000001:1', 'NOPE')).toBeUndefined();
    expect(device.dataPoint('VCU0000001:9', 'STATE')).toBeUndefined();
  });

  it('flattens all data points across channels', () => {
    const device = makeDevice();
    const all = device.allDataPoints();
    expect(all).toHaveLength(2);
    expect(all.map((dp) => dp.parameter).sort()).toEqual(['LEVEL', 'STATE']);
  });
});
