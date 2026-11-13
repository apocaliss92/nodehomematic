/**
 * Renames and rooms over `ReGa.runScript` against an in-process {@link FakeCcu}.
 * The real CCU was not used: these calls need a WebUI session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { buildFakeFacade, FAKE_PASSWORD, FAKE_USERNAME } from './helpers/build-facade.js';
import type { Homematic } from '../../src/api/homematic.js';
import { ValidationError } from '../../src/support/errors.js';

const DEVICE = 'VCU0000001';
const CONTACT = `${DEVICE}:1`;
const MAINTENANCE = `${DEVICE}:0`;
const LIVING_ROOM = '1234';

describe('renames and rooms (fake CCU)', () => {
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

  describe('renames', () => {
    it('renames a device and its channels to <name>:<index>', async () => {
      const result = await hm.renameDevice(DEVICE, '  Front door ', { renameChannels: true });

      expect(result).toEqual({
        device: { address: DEVICE, name: 'Front door' },
        channels: [
          { address: MAINTENANCE, name: 'Front door:0' },
          { address: CONTACT, name: 'Front door:1' },
        ],
      });
      expect(fakeCcu.rega.nameOf(CONTACT)).toBe('Front door:1');
      const device = hm.devices().find((d) => d.address === DEVICE);
      expect(device?.name).toBe('Front door');
      expect(device?.channels.find((c) => c.address === CONTACT)?.name).toBe('Front door:1');
    });

    it('renames only the device when renameChannels is false', async () => {
      const result = await hm.renameDevice(DEVICE, 'Front door', { renameChannels: false });

      expect(result.channels).toEqual([]);
      expect(fakeCcu.rega.nameOf(CONTACT)).toBe('Window Contact Sensor');
    });

    it('carries quotes, backslashes and latin1 through the ReGa escaping', async () => {
      const name = 'Bad "quote" \\ path - Küche';
      const result = await hm.renameChannel(CONTACT, name);

      expect(result).toEqual({ address: CONTACT, name });
      expect(fakeCcu.rega.nameOf(CONTACT)).toBe(name);
      const channel = hm
        .devices()
        .find((d) => d.address === DEVICE)
        ?.channels.find((c) => c.address === CONTACT);
      expect(channel?.name).toBe(name);
    });

    it('validates before any script runs', async () => {
      await expect(hm.renameDevice('NOPE000001', 'x', { renameChannels: false })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(hm.renameChannel(CONTACT, '   ')).rejects.toBeInstanceOf(ValidationError);
      await expect(hm.renameChannel(CONTACT, 'line\nbreak')).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(hm.renameChannel(CONTACT, 'x'.repeat(129))).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(hm.renameChannel(DEVICE, 'x')).rejects.toBeInstanceOf(ValidationError);
      expect(fakeCcu.rega.ops).toEqual([]);
    });
  });

  describe('rooms', () => {
    it('lists rooms with their member channel addresses', async () => {
      expect(await hm.listRooms()).toEqual([
        { id: LIVING_ROOM, name: 'Living Room', channels: [CONTACT] },
      ]);
    });

    it('creates a room, refuses a duplicate name, renames and deletes it', async () => {
      const room = await hm.createRoom('Küche');
      expect(room).toEqual({ id: '9000', name: 'Küche', channels: [] });
      await expect(hm.createRoom('Küche')).rejects.toBeInstanceOf(ValidationError);

      await hm.renameRoom(room.id, 'Kitchen');
      expect((await hm.listRooms()).map((r) => r.name)).toEqual(['Living Room', 'Kitchen']);

      await hm.deleteRoom(room.id);
      expect((await hm.listRooms()).map((r) => r.id)).toEqual([LIVING_ROOM]);
      await expect(hm.deleteRoom(room.id)).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses to delete an unerasable room', async () => {
      fakeCcu.rega.markUnerasable(LIVING_ROOM);
      await expect(hm.deleteRoom(LIVING_ROOM)).rejects.toThrow(/unerasable/);
      expect(fakeCcu.rega.rooms().map((r) => r.id)).toEqual([LIVING_ROOM]);
    });

    it('adds and removes a channel', async () => {
      await hm.addChannelToRoom(LIVING_ROOM, MAINTENANCE);
      await hm.addChannelToRoom(LIVING_ROOM, MAINTENANCE);
      expect(fakeCcu.rega.rooms()[0]?.channels).toEqual([CONTACT, MAINTENANCE]);

      await hm.removeChannelFromRoom(LIVING_ROOM, CONTACT);
      expect(fakeCcu.rega.rooms()[0]?.channels).toEqual([MAINTENANCE]);
    });

    it('refuses an unknown channel, an unknown room and an invalid room id', async () => {
      await expect(hm.addChannelToRoom(LIVING_ROOM, 'NOPE000001:1')).rejects.toThrow(
        /Unknown channel/,
      );
      await expect(hm.addChannelToRoom('77', CONTACT)).rejects.toThrow(/Unknown room/);
      await expect(hm.renameRoom('77', 'x')).rejects.toBeInstanceOf(ValidationError);

      const opsBefore = fakeCcu.rega.ops.length;
      await expect(hm.deleteRoom('1; x')).rejects.toBeInstanceOf(ValidationError);
      await expect(hm.addChannelToRoom(LIVING_ROOM, DEVICE)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fakeCcu.rega.ops).toHaveLength(opsBefore);
    });
  });
});

describe('renames and rooms without WebUI credentials', () => {
  it('is a ValidationError, and no script runs', async () => {
    const fakeCcu = new FakeCcu({ username: FAKE_USERNAME, password: FAKE_PASSWORD });
    await fakeCcu.start();
    const hm = buildFakeFacade(fakeCcu, false);
    await hm.start();
    try {
      await expect(hm.listRooms()).rejects.toBeInstanceOf(ValidationError);
      await expect(
        hm.renameDevice(DEVICE, 'x', { renameChannels: false }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fakeCcu.rega.ops).toEqual([]);
    } finally {
      await hm.stop();
      await fakeCcu.stop();
    }
  });
});
