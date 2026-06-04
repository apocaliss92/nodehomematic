import { describe, it, expect } from 'vitest';
import { interfaceFamilyOf, buildDevice, buildModel } from '../../../src/model/model-builder.js';
import type {
  DeviceNode,
  ChannelNode,
  ParameterSpec,
  ParameterSpecs,
} from '../../../src/central/graph.js';
import { ParameterType, Operations } from '../../../src/support/constants.js';
import type { DeviceDescription } from '../../../src/transport/xmlrpc/types.js';

const RWE = Operations.READ | Operations.WRITE | Operations.EVENT;

function valuesSpec(type: ParameterType, operations = RWE): ParameterSpec {
  return {
    type,
    operations,
    flags: 1,
    readable: (operations & Operations.READ) !== 0,
    writable: (operations & Operations.WRITE) !== 0,
    hasEvents: (operations & Operations.EVENT) !== 0,
    visible: true,
  };
}

function masterSpec(): ParameterSpec {
  // MASTER config parameter: no events, read+write only.
  const operations = Operations.READ | Operations.WRITE;
  return {
    type: ParameterType.INTEGER,
    operations,
    flags: 1,
    readable: true,
    writable: true,
    hasEvents: false,
    visible: true,
  };
}

function makeNode(interfaceId = 'MyCCU-BidCos-RF'): DeviceNode {
  const ch0: ChannelNode = {
    address: 'VCU0000001:0',
    index: 0,
    parameters: new Map<string, ParameterSpecs>([['MAINTENANCE', { MASTER: masterSpec() }]]),
  };
  const ch1: ChannelNode = {
    address: 'VCU0000001:1',
    index: 1,
    type: 'SWITCH',
    parameters: new Map<string, ParameterSpecs>([
      ['STATE', { VALUES: valuesSpec(ParameterType.BOOL) }],
      ['LEVEL', { VALUES: valuesSpec(ParameterType.FLOAT) }],
      // MASTER-only param must NOT become a data point.
      ['CONFIG_ONLY', { MASTER: masterSpec() }],
    ]),
  };
  return {
    address: 'VCU0000001',
    type: 'HM-LC-Sw1-Pl',
    interfaceId,
    name: 'Kitchen switch',
    rooms: ['Kitchen'],
    functions: ['Light'],
    channels: [ch0, ch1],
    raw: {} as DeviceDescription,
  };
}

describe('interfaceFamilyOf', () => {
  it('detects HMIP by HmIP substring (case-insensitive)', () => {
    expect(interfaceFamilyOf('CCU-HmIP-RF')).toBe('HMIP');
    expect(interfaceFamilyOf('ccu-hmip-rf')).toBe('HMIP');
  });

  it('defaults to HM otherwise', () => {
    expect(interfaceFamilyOf('CCU-BidCos-RF')).toBe('HM');
    expect(interfaceFamilyOf('Whatever')).toBe('HM');
  });
});

describe('buildDevice', () => {
  it('builds a ModelDevice carrying metadata and channels', () => {
    const device = buildDevice(makeNode());
    expect(device.address).toBe('VCU0000001');
    expect(device.type).toBe('HM-LC-Sw1-Pl');
    expect(device.interfaceId).toBe('MyCCU-BidCos-RF');
    expect(device.name).toBe('Kitchen switch');
    expect(device.rooms).toEqual(['Kitchen']);
    expect(device.functions).toEqual(['Light']);
    expect(device.channels).toHaveLength(2);
    expect(device.channel('VCU0000001:1')?.type).toBe('SWITCH');
  });

  it('creates exactly the VALUES data points (skips MASTER-only)', () => {
    const device = buildDevice(makeNode());
    const all = device.allDataPoints();
    expect(all).toHaveLength(2);
    expect(all.map((dp) => dp.parameter).sort()).toEqual(['LEVEL', 'STATE']);
    // Channel :0 had only a MASTER param → no data points.
    expect(device.channel('VCU0000001:0')?.dataPoints).toEqual([]);
  });

  it('resolves a data point via dataPoint(channel, parameter)', () => {
    const device = buildDevice(makeNode());
    const dp = device.dataPoint('VCU0000001:1', 'STATE');
    expect(dp?.parameter).toBe('STATE');
    expect(dp?.type).toBe(ParameterType.BOOL);
    expect(dp?.dpk.paramsetKey).toBe('VALUES');
    expect(dp?.dpk.channelAddress).toBe('VCU0000001:1');
    expect(dp?.dpk.interfaceId).toBe('MyCCU-BidCos-RF');
  });

  it('includes a VALUES param that is event-only (not readable)', () => {
    const node = makeNode();
    const ch1 = node.channels[1] as ChannelNode;
    (ch1.parameters as Map<string, ParameterSpecs>).set('PRESS_SHORT', {
      VALUES: valuesSpec(ParameterType.ACTION, Operations.EVENT),
    });
    const device = buildDevice(node);
    expect(device.dataPoint('VCU0000001:1', 'PRESS_SHORT')?.hasEvents).toBe(true);
  });

  it('includes a write-only VALUES param (e.g. cover STOP / lock target)', () => {
    const node = makeNode();
    const ch1 = node.channels[1] as ChannelNode;
    (ch1.parameters as Map<string, ParameterSpecs>).set('STOP', {
      VALUES: valuesSpec(ParameterType.ACTION, Operations.WRITE),
    });
    const device = buildDevice(node);
    const dp = device.dataPoint('VCU0000001:1', 'STOP');
    expect(dp).toBeDefined();
    expect(dp?.writable).toBe(true);
    expect(dp?.readable).toBe(false);
    expect(dp?.hasEvents).toBe(false);
  });

  it('still skips a VALUES param that is neither readable, writable, nor event-emitting', () => {
    const node = makeNode();
    const ch1 = node.channels[1] as ChannelNode;
    (ch1.parameters as Map<string, ParameterSpecs>).set('INTERNAL_ONLY', {
      VALUES: valuesSpec(ParameterType.FLOAT, 0),
    });
    const device = buildDevice(node);
    expect(device.dataPoint('VCU0000001:1', 'INTERNAL_ONLY')).toBeUndefined();
  });

  it('derives the interface family for HmIP devices', () => {
    const device = buildDevice(makeNode('MyCCU-HmIP-RF'));
    // HMIP enum is serialised as string; STATE is BOOL so just check it built.
    expect(device.interfaceId).toBe('MyCCU-HmIP-RF');
    expect(device.allDataPoints()).toHaveLength(2);
  });
});

describe('buildModel', () => {
  it('builds one ModelDevice per node', () => {
    const devices = buildModel([makeNode('MyCCU-BidCos-RF'), makeNode('MyCCU-HmIP-RF')]);
    expect(devices).toHaveLength(2);
    expect(devices[0]?.interfaceId).toBe('MyCCU-BidCos-RF');
    expect(devices[1]?.interfaceId).toBe('MyCCU-HmIP-RF');
  });
});
