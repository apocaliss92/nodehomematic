import { describe, it, expect } from 'vitest';
import { ModelDevice } from '../../../../src/model/device.js';
import { ModelChannel } from '../../../../src/model/channel.js';
import { buildCustomEntities } from '../../../../src/model/custom/resolve.js';
import { SwitchEntity } from '../../../../src/model/custom/switch.js';
// Importing the index registers the built-in families as a side effect.
import '../../../../src/model/custom/index.js';
import { makeSwitchDevice, makeDp, recordingWriter, INTERFACE_ID } from './fixtures.js';
import { ParameterType } from '../../../../src/support/constants.js';

describe('buildCustomEntities', () => {
  it('builds a SwitchEntity for an HmIP-PS device (channel 3)', () => {
    const { device, state } = makeSwitchDevice();
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);

    expect(entities).toHaveLength(1);
    const entity = entities[0];
    expect(entity).toBeInstanceOf(SwitchEntity);
    expect(entity?.primaryChannelAddress).toBe('VCU0000001:3');
    expect(entity?.type).toBe('HmIP-PS');

    const sw = entity as SwitchEntity;
    expect(sw.isOn).toBe(false);
    state.applyCcuValue(true, 1);
    expect(sw.isOn).toBe(true);
  });

  it('turnOn from a resolved entity routes to the writer with the STATE dpk', async () => {
    const { device } = makeSwitchDevice();
    const { writer, calls } = recordingWriter();
    const [entity] = buildCustomEntities(device, writer);
    await (entity as SwitchEntity).turnOn();
    expect(calls).toEqual([{ channelAddress: 'VCU0000001:3', parameter: 'STATE', value: true }]);
  });

  it('matches by prefix (HmIP-PSM uses the HmIP-PS registration)', () => {
    const state = makeDp('VCU0000002:3', 'STATE', ParameterType.BOOL);
    const ch3 = new ModelChannel({ address: 'VCU0000002:3', index: 3, dataPoints: [state] });
    const device = new ModelDevice({
      address: 'VCU0000002',
      type: 'HmIP-PSM',
      interfaceId: INTERFACE_ID,
      channels: [ch3],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(SwitchEntity);
  });

  it('builds TWO SwitchEntity for an HmIP-BS2 (dual brand-switch actuator, channels 4 and 8)', () => {
    // Live layout (verified on a real CCU): ch1-2 KEY_TRANSCEIVER, ch3/ch7
    // SWITCH_TRANSMITTER read-back, ch4-6/ch8-10 SWITCH_VIRTUAL_RECEIVER —
    // one relay per group, primary = the first VIRTUAL_RECEIVER (4 and 8).
    const state4 = makeDp('VCU0000005:4', 'STATE', ParameterType.BOOL);
    const state8 = makeDp('VCU0000005:8', 'STATE', ParameterType.BOOL);
    const device = new ModelDevice({
      address: 'VCU0000005',
      type: 'HmIP-BS2',
      interfaceId: INTERFACE_ID,
      channels: [
        new ModelChannel({ address: 'VCU0000005:4', index: 4, dataPoints: [state4] }),
        new ModelChannel({ address: 'VCU0000005:8', index: 8, dataPoints: [state8] }),
      ],
    });
    const { writer, calls } = recordingWriter();
    const entities = buildCustomEntities(device, writer);

    expect(entities).toHaveLength(2);
    expect(entities.every((e) => e instanceof SwitchEntity)).toBe(true);
    expect(entities.map((e) => e.primaryChannelAddress)).toEqual([
      'VCU0000005:4',
      'VCU0000005:8',
    ]);

    // The two relays are independent: each entity reads and writes ITS channel.
    const [relay1, relay2] = entities as [SwitchEntity, SwitchEntity];
    state8.applyCcuValue(true, 1);
    expect(relay1.isOn).toBe(false);
    expect(relay2.isOn).toBe(true);
    void relay1.turnOn();
    expect(calls).toEqual([{ channelAddress: 'VCU0000005:4', parameter: 'STATE', value: true }]);
  });

  it('returns [] for an unregistered device type', () => {
    const ch = new ModelChannel({ address: 'VCU0000003:1', index: 1, dataPoints: [] });
    const device = new ModelDevice({
      address: 'VCU0000003',
      type: 'HmIP-NOPE',
      interfaceId: INTERFACE_ID,
      channels: [ch],
    });
    const { writer } = recordingWriter();
    expect(buildCustomEntities(device, writer)).toEqual([]);
  });

  it('skips a config whose data points are all absent', () => {
    // HM-LC-Sw registration targets channel 1; provide a device with no STATE there.
    const ch1 = new ModelChannel({ address: 'VCU0000004:1', index: 1, dataPoints: [] });
    const device = new ModelDevice({
      address: 'VCU0000004',
      type: 'HM-LC-Sw1-Pl',
      interfaceId: INTERFACE_ID,
      channels: [ch1],
    });
    const { writer } = recordingWriter();
    expect(buildCustomEntities(device, writer)).toEqual([]);
  });
});
