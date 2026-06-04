import { describe, it, expect } from 'vitest';
import { DeviceRegistry } from '../../../src/central/device-registry.js';
import {
  parameterSpecFromData,
  type DeviceNode,
  type ChannelNode,
} from '../../../src/central/graph.js';
import { makeDpk } from '../../../src/support/dpk.js';
import { Operations, Flag } from '../../../src/support/constants.js';
import type { DeviceDescription, ParameterData } from '../../../src/transport/xmlrpc/types.js';

const IFACE = 'ccu-HmIP-RF';

function valueParam(): ParameterData {
  return {
    TYPE: 'BOOL',
    OPERATIONS: Operations.READ | Operations.WRITE | Operations.EVENT,
    FLAGS: Flag.VISIBLE,
  };
}

function channel(address: string, index: number, withValues: boolean): ChannelNode {
  const parameters = new Map<string, { VALUES?: ReturnType<typeof parameterSpecFromData> }>();
  if (withValues) {
    parameters.set('STATE', { VALUES: parameterSpecFromData(valueParam()) });
  }
  return { address, index, type: 'SWITCH', direction: 1, parameters };
}

function deviceNode(address: string): DeviceNode {
  const raw: DeviceDescription = { ADDRESS: address, TYPE: 'HmIP-SW', PARAMSETS: [] };
  return {
    address,
    type: 'HmIP-SW',
    interfaceId: IFACE,
    firmware: '1.0',
    name: 'Kitchen Switch',
    rooms: ['Kitchen'],
    functions: ['Light'],
    channels: [channel(`${address}:1`, 1, true), channel(`${address}:2`, 2, false)],
    raw,
  };
}

describe('central/DeviceRegistry', () => {
  it('upsert then get and getAll', () => {
    const reg = new DeviceRegistry();
    expect(reg.get('VCU1')).toBeUndefined();
    reg.upsert(deviceNode('VCU1'));
    reg.upsert(deviceNode('VCU2'));
    expect(reg.get('VCU1')?.name).toBe('Kitchen Switch');
    expect(
      reg
        .getAll()
        .map((d) => d.address)
        .sort(),
    ).toEqual(['VCU1', 'VCU2']);
  });

  it('upsert replaces an existing device by address', () => {
    const reg = new DeviceRegistry();
    reg.upsert(deviceNode('VCU1'));
    const replacement: DeviceNode = { ...deviceNode('VCU1'), name: 'Renamed' };
    reg.upsert(replacement);
    expect(reg.getAll()).toHaveLength(1);
    expect(reg.get('VCU1')?.name).toBe('Renamed');
  });

  it('getChannel resolves a channel by its address', () => {
    const reg = new DeviceRegistry();
    reg.upsert(deviceNode('VCU1'));
    expect(reg.getChannel('VCU1:1')?.index).toBe(1);
    expect(reg.getChannel('VCU1:2')?.index).toBe(2);
    expect(reg.getChannel('VCU1:9')).toBeUndefined();
    expect(reg.getChannel('NODEV:1')).toBeUndefined();
    expect(reg.getChannel('no-colon')).toBeUndefined();
  });

  it('resolveParameter resolves a VALUES parameter by dpk', () => {
    const reg = new DeviceRegistry();
    reg.upsert(deviceNode('VCU1'));
    const spec = reg.resolveParameter(makeDpk(IFACE, 'VCU1:1', 'VALUES', 'STATE'));
    expect(spec?.writable).toBe(true);
    expect(reg.resolveParameter(makeDpk(IFACE, 'VCU1:1', 'MASTER', 'STATE'))).toBeUndefined();
    expect(reg.resolveParameter(makeDpk(IFACE, 'VCU1:2', 'VALUES', 'STATE'))).toBeUndefined();
    expect(reg.resolveParameter(makeDpk(IFACE, 'VCU9:1', 'VALUES', 'STATE'))).toBeUndefined();
  });

  it('removeDevice removes the device and its channels', () => {
    const reg = new DeviceRegistry();
    reg.upsert(deviceNode('VCU1'));
    reg.removeDevice('VCU1');
    expect(reg.get('VCU1')).toBeUndefined();
    expect(reg.getChannel('VCU1:1')).toBeUndefined();
    expect(reg.resolveParameter(makeDpk(IFACE, 'VCU1:1', 'VALUES', 'STATE'))).toBeUndefined();
  });

  it('getAll returns a snapshot that does not mutate internal state', () => {
    const reg = new DeviceRegistry();
    reg.upsert(deviceNode('VCU1'));
    const snapshot = reg.getAll();
    snapshot.pop();
    expect(reg.getAll()).toHaveLength(1);
  });
});
