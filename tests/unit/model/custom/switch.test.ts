import { describe, it, expect } from 'vitest';
import { SwitchEntity } from '../../../../src/model/custom/switch.js';
import { Field } from '../../../../src/model/custom/fields.js';
import { GenericDataPoint } from '../../../../src/model/data-point.js';
import { ParameterType } from '../../../../src/support/constants.js';
import { makeDp, recordingWriter } from './fixtures.js';

function makeSwitch() {
  const { writer, calls } = recordingWriter();
  const state = makeDp('VCU0000001:3', 'STATE', ParameterType.BOOL);
  const dataPoints = new Map<Field, GenericDataPoint>([[Field.STATE, state]]);
  const entity = new SwitchEntity({
    deviceAddress: 'VCU0000001',
    primaryChannelAddress: 'VCU0000001:3',
    type: 'HmIP-PS',
    dataPoints,
    writer,
  });
  return { entity, state, calls };
}

describe('SwitchEntity', () => {
  it('kind is switch', () => {
    expect(makeSwitch().entity.kind).toBe('switch');
  });

  it('isOn reflects the STATE data point value', () => {
    const { entity, state } = makeSwitch();
    expect(entity.isOn).toBe(false);
    state.applyCcuValue(true, 1);
    expect(entity.isOn).toBe(true);
    state.applyCcuValue(false, 2);
    expect(entity.isOn).toBe(false);
  });

  it('turnOn writes STATE=true to the primary channel', async () => {
    const { entity, calls } = makeSwitch();
    await entity.turnOn();
    expect(calls).toEqual([{ channelAddress: 'VCU0000001:3', parameter: 'STATE', value: true }]);
  });

  it('turnOff writes STATE=false to the primary channel', async () => {
    const { entity, calls } = makeSwitch();
    await entity.turnOff();
    expect(calls).toEqual([{ channelAddress: 'VCU0000001:3', parameter: 'STATE', value: false }]);
  });
});
