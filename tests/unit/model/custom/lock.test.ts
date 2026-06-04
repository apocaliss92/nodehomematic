import { describe, it, expect } from 'vitest';
import { IpLockEntity, RfLockEntity } from '../../../../src/model/custom/lock.js';
import { Field } from '../../../../src/model/custom/fields.js';
import { GenericDataPoint } from '../../../../src/model/data-point.js';
import { ModelDevice } from '../../../../src/model/device.js';
import { ModelChannel } from '../../../../src/model/channel.js';
import { ParameterType } from '../../../../src/support/constants.js';
import { buildCustomEntities } from '../../../../src/model/custom/resolve.js';
// Importing the index registers the built-in families as a side effect.
import '../../../../src/model/custom/index.js';
import { makeDp, recordingWriter, INTERFACE_ID } from './fixtures.js';

function makeIpLock(channel = 'VCU0000040:1'): {
  entity: IpLockEntity;
  lockState: GenericDataPoint;
  target: GenericDataPoint;
  calls: ReturnType<typeof recordingWriter>['calls'];
} {
  const { writer, calls } = recordingWriter();
  const lockState = makeDp(channel, 'LOCK_STATE', ParameterType.ENUM);
  const target = makeDp(channel, 'LOCK_TARGET_LEVEL', ParameterType.ENUM);
  const dataPoints = new Map<Field, GenericDataPoint>([
    [Field.LOCK_STATE, lockState],
    [Field.LOCK_TARGET_LEVEL, target],
  ]);
  const entity = new IpLockEntity({
    deviceAddress: 'VCU0000040',
    primaryChannelAddress: channel,
    type: 'HmIP-DLD',
    dataPoints,
    writer,
  });
  return { entity, lockState, target, calls };
}

describe('IpLockEntity', () => {
  it('kind is lock', () => {
    expect(makeIpLock().entity.kind).toBe('lock');
  });

  it('isLocked reflects LOCK_STATE', () => {
    const { entity, lockState } = makeIpLock();
    expect(entity.isLocked).toBe(false);
    lockState.applyCcuValue('LOCKED', 1);
    expect(entity.isLocked).toBe(true);
    lockState.applyCcuValue('UNLOCKED', 2);
    expect(entity.isLocked).toBe(false);
  });

  it('lock writes LOCK_TARGET_LEVEL=LOCKED', async () => {
    const { entity, calls } = makeIpLock();
    await entity.lock();
    expect(calls).toEqual([
      { channelAddress: 'VCU0000040:1', parameter: 'LOCK_TARGET_LEVEL', value: 'LOCKED' },
    ]);
  });

  it('unlock writes LOCK_TARGET_LEVEL=UNLOCKED', async () => {
    const { entity, calls } = makeIpLock();
    await entity.unlock();
    expect(calls).toEqual([
      { channelAddress: 'VCU0000040:1', parameter: 'LOCK_TARGET_LEVEL', value: 'UNLOCKED' },
    ]);
  });

  it('open writes LOCK_TARGET_LEVEL=OPEN', async () => {
    const { entity, calls } = makeIpLock();
    await entity.open();
    expect(calls).toEqual([
      { channelAddress: 'VCU0000040:1', parameter: 'LOCK_TARGET_LEVEL', value: 'OPEN' },
    ]);
  });
});

function makeRfLock(channel = 'VCU0000041:1'): {
  entity: RfLockEntity;
  state: GenericDataPoint;
  openDp: GenericDataPoint;
  calls: ReturnType<typeof recordingWriter>['calls'];
} {
  const { writer, calls } = recordingWriter();
  const state = makeDp(channel, 'STATE', ParameterType.BOOL);
  const openDp = makeDp(channel, 'OPEN', ParameterType.ACTION);
  const dataPoints = new Map<Field, GenericDataPoint>([
    [Field.STATE, state],
    [Field.OPEN, openDp],
  ]);
  const entity = new RfLockEntity({
    deviceAddress: 'VCU0000041',
    primaryChannelAddress: channel,
    type: 'HM-Sec-Key',
    dataPoints,
    writer,
  });
  return { entity, state, openDp, calls };
}

describe('RfLockEntity', () => {
  it('kind is lock', () => {
    expect(makeRfLock().entity.kind).toBe('lock');
  });

  it('isLocked is true when STATE is not true (false = locked)', () => {
    const { entity, state } = makeRfLock();
    state.applyCcuValue(false, 1);
    expect(entity.isLocked).toBe(true);
    state.applyCcuValue(true, 2);
    expect(entity.isLocked).toBe(false);
  });

  it('lock writes STATE=false', async () => {
    const { entity, calls } = makeRfLock();
    await entity.lock();
    expect(calls).toEqual([{ channelAddress: 'VCU0000041:1', parameter: 'STATE', value: false }]);
  });

  it('unlock writes STATE=true', async () => {
    const { entity, calls } = makeRfLock();
    await entity.unlock();
    expect(calls).toEqual([{ channelAddress: 'VCU0000041:1', parameter: 'STATE', value: true }]);
  });

  it('open writes OPEN=true', async () => {
    const { entity, calls } = makeRfLock();
    await entity.open();
    expect(calls).toEqual([{ channelAddress: 'VCU0000041:1', parameter: 'OPEN', value: true }]);
  });
});

describe('Lock registry', () => {
  it('resolves an IpLockEntity for HmIP-DLD (channel 1)', () => {
    const lockState = makeDp('VCU0000042:1', 'LOCK_STATE', ParameterType.ENUM);
    const target = makeDp('VCU0000042:1', 'LOCK_TARGET_LEVEL', ParameterType.ENUM);
    const ch1 = new ModelChannel({
      address: 'VCU0000042:1',
      index: 1,
      dataPoints: [lockState, target],
    });
    const device = new ModelDevice({
      address: 'VCU0000042',
      type: 'HmIP-DLD',
      interfaceId: INTERFACE_ID,
      channels: [ch1],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(IpLockEntity);
    expect(entities[0]?.kind).toBe('lock');
  });

  it('resolves an RfLockEntity for HM-Sec-Key (channel 1)', () => {
    const state = makeDp('VCU0000043:1', 'STATE', ParameterType.BOOL);
    const openDp = makeDp('VCU0000043:1', 'OPEN', ParameterType.ACTION);
    const ch1 = new ModelChannel({
      address: 'VCU0000043:1',
      index: 1,
      dataPoints: [state, openDp],
    });
    const device = new ModelDevice({
      address: 'VCU0000043',
      type: 'HM-Sec-Key-S',
      interfaceId: INTERFACE_ID,
      channels: [ch1],
    });
    const { writer } = recordingWriter();
    const entities = buildCustomEntities(device, writer);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(RfLockEntity);
  });
});
