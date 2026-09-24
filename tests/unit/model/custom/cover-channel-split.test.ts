/**
 * An HmIP cover REPORTS on one channel and is COMMANDED on another.
 *
 * Measured on a live CCU, HmIP-BROLL `00111BE992A8E5`:
 *
 *   :3 SHUTTER_TRANSMITTER       LEVEL 0.475  R-E   ← where the cover IS
 *   :4 SHUTTER_VIRTUAL_RECEIVER  LEVEL 1.0    RWE   ← where you COMMAND it
 *
 * The profile bound both to :4, so `currentPosition` answered the last
 * commanded extreme — 0 or 100 and nothing between, and plainly wrong whenever
 * the cover rests part-way. It read 100 with the slat at 47.5 %.
 *
 * This suite builds the device the way the CCU describes it, through the real
 * `buildCustomEntities`. The older `cover.test.ts` constructs the entity from a
 * hand-made data-point map, so it cannot see this at all.
 */
import { describe, it, expect } from 'vitest';
import { ModelDevice } from '../../../../src/model/device.js';
import { ModelChannel } from '../../../../src/model/channel.js';
import { ParameterType } from '../../../../src/support/constants.js';
import { buildCustomEntities } from '../../../../src/model/custom/resolve.js';
import { CoverEntity } from '../../../../src/model/custom/cover.js';
import '../../../../src/model/custom/index.js';
import { makeDp, recordingWriter, INTERFACE_ID } from './fixtures.js';

const ADDRESS = 'VCU0000042';

function makeBroll() {
  const { writer, calls } = recordingWriter();
  // :3 SHUTTER_TRANSMITTER — the device reporting itself.
  const level3 = makeDp(`${ADDRESS}:3`, 'LEVEL', ParameterType.FLOAT);
  const activity3 = makeDp(`${ADDRESS}:3`, 'ACTIVITY_STATE', ParameterType.ENUM);
  // :4 SHUTTER_VIRTUAL_RECEIVER — the link/group target you write to.
  const level4 = makeDp(`${ADDRESS}:4`, 'LEVEL', ParameterType.FLOAT);
  const activity4 = makeDp(`${ADDRESS}:4`, 'ACTIVITY_STATE', ParameterType.ENUM);
  const stop4 = makeDp(`${ADDRESS}:4`, 'STOP', ParameterType.ACTION);

  const device = new ModelDevice({
    address: ADDRESS,
    type: 'HmIP-BROLL',
    interfaceId: INTERFACE_ID,
    channels: [
      new ModelChannel({
        address: `${ADDRESS}:3`,
        index: 3,
        type: 'SHUTTER_TRANSMITTER',
        dataPoints: [level3, activity3],
      }),
      new ModelChannel({
        address: `${ADDRESS}:4`,
        index: 4,
        type: 'SHUTTER_VIRTUAL_RECEIVER',
        dataPoints: [level4, activity4, stop4],
      }),
    ],
  });
  const entity = buildCustomEntities(device, writer).find(
    (e): e is CoverEntity => e instanceof CoverEntity,
  );
  expect(entity).toBeDefined();
  return { entity: entity as CoverEntity, level3, level4, activity3, activity4, calls };
}

describe('an HmIP cover reads the transmitter and commands the receiver', () => {
  it('reports the position the TRANSMITTER holds, not the receiver', () => {
    const { entity, level3, level4 } = makeBroll();
    // Exactly the live reading that exposed this.
    level3.applyCcuValue(0.475, 1);
    level4.applyCcuValue(1.0, 1);
    // 48, not 47.5: `levelToPosition` rounds. (HA prints 47 for the same
    // reading — it truncates. Half a point apart, and neither is 100.)
    expect(entity.currentPosition).toBe(48);
  });

  it('is not fooled into "fully open" by the receiver', () => {
    const { entity, level3, level4 } = makeBroll();
    level3.applyCcuValue(0, 1);
    level4.applyCcuValue(1.0, 1);
    expect(entity.isClosed).toBe(true);
  });

  it('reads TRAVEL from the transmitter too', () => {
    const { entity, activity3, activity4 } = makeBroll();
    activity3.applyCcuValue('DOWN', 1);
    activity4.applyCcuValue('STABLE', 1);
    expect(entity.travel).toBe('closing');
    expect(entity.isClosing).toBe(true);
  });

  it('WRITES to the receiver — the transmitter refuses writes on the CCU', () => {
    const { entity, calls } = makeBroll();
    void entity.close();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channelAddress).toBe(`${ADDRESS}:4`);
    expect(calls[0]?.parameter).toBe('LEVEL');
  });

  it('names BOTH channels it touches', () => {
    // A consumer filtering `valueChanged` by the command channel alone drops
    // exactly the reports the entity exists to expose — which is what happened
    // downstream: the library resolved the transmitter and the consumer threw
    // its events away, so the fix looked like it had done nothing.
    const { entity } = makeBroll();
    expect([...entity.channelAddresses].sort()).toEqual([`${ADDRESS}:3`, `${ADDRESS}:4`]);
  });

  it('wakes a subscriber on a TRANSMITTER change', () => {
    // The split is worthless if nobody is told. `subscribe` used to walk the
    // command bindings only, so the very value the entity reads would have
    // changed with no notification.
    const { entity, level3 } = makeBroll();
    let woken = 0;
    const off = entity.subscribe(() => {
      woken += 1;
    });
    level3.applyCcuValue(0.2, 1);
    off();
    expect(woken).toBeGreaterThan(0);
  });
});
