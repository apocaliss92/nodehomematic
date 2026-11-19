/**
 * Names are read from the CCU WebUI at start; a rename done on the CCU, or a
 * name given after a device was paired, must reach `devices()` without a restart.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { buildFakeFacade, FAKE_PASSWORD, FAKE_USERNAME } from './helpers/build-facade.js';
import type { Homematic } from '../../src/api/homematic.js';

const DEVICE = 'VCU0000001';
const CONTACT = `${DEVICE}:1`;

function nameOf(hm: Homematic, address: string): string | null | undefined {
  const device = hm.devices().find((d) => d.address === DEVICE);
  if (address === DEVICE) return device?.name;
  return device?.channels.find((c) => c.address === address)?.name;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('names re-read from the CCU (fake CCU)', () => {
  let fakeCcu: FakeCcu;
  let hm: Homematic;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({ username: FAKE_USERNAME, password: FAKE_PASSWORD });
    await fakeCcu.start();
    hm = buildFakeFacade(fakeCcu);
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
    await fakeCcu.stop();
  });

  it('refreshNames picks up a rename made on the CCU, device and channel', async () => {
    expect(nameOf(hm, DEVICE)).toBe('Window Contact');
    fakeCcu.setDetailName(DEVICE, 'Bedroom valve');
    fakeCcu.setDetailName(CONTACT, 'Bedroom valve:1');
    expect(nameOf(hm, DEVICE)).toBe('Window Contact');

    await hm.refreshNames();

    expect(nameOf(hm, DEVICE)).toBe('Bedroom valve');
    expect(nameOf(hm, CONTACT)).toBe('Bedroom valve:1');
  });

  it('refreshNames keeps what it had when the CCU cannot answer', async () => {
    await hm.stop();
    await fakeCcu.stop();
    fakeCcu = new FakeCcu({
      username: FAKE_USERNAME,
      password: FAKE_PASSWORD,
    });
    await fakeCcu.start();
    hm = buildFakeFacade(fakeCcu, false);
    await hm.start();

    await expect(hm.refreshNames()).resolves.toBeUndefined();
    expect(nameOf(hm, DEVICE)).toBeNull();
  });

  it('a newDevices push re-reads names first, so a name given after pairing shows', async () => {
    fakeCcu.setDetailName(DEVICE, 'Named after pairing');

    await fakeCcu.emitNewDevices([{ ADDRESS: DEVICE, TYPE: 'HmIP-SWDO' }]);

    await until(() => nameOf(hm, DEVICE) === 'Named after pairing');
  });
});
