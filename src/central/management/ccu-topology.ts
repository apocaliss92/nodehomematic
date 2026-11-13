/**
 * Names and rooms of the CCU's ReGa object model, read and written through
 * `ReGa.runScript` (the scripts and their eq-3/occu sources are in
 * `../rega/scripts.ts`). Every input is validated before a script runs; every
 * answer arrives as `unknown` and is narrowed here.
 */
import type { HmDeviceRename, HmNamedObject, HmRoom } from '../../api/types.js';
import { ClientError, ValidationError } from '../../support/errors.js';
import { decodeRegaName } from '../rega/rega-runner.js';
import {
  CREATE_ROOM,
  DELETE_ROOM,
  LIST_ROOMS,
  RENAME_CHANNEL,
  RENAME_DEVICE,
  RENAME_ROOM,
  ROOM_CHANNEL,
} from '../rega/scripts.js';

/** Runs one ReGa script with `##key##` params; failures name `label`. */
export type RegaScriptRunner = (
  label: string,
  script: string,
  params?: Record<string, string | number>,
) => Promise<unknown>;

const ROOM_ID = /^\d+$/;
const DEVICE_ADDRESS = /^[0-9A-Za-z_-]+$/;
const CHANNEL_ADDRESS = /^[0-9A-Za-z_-]+:\d+$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
/** Longest name accepted; the WebUI's own name fields stop well below this. */
const MAX_NAME = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validName(raw: string, what: string): string {
  const name = raw.trim();
  if (name === '' || name.length > MAX_NAME || CONTROL_CHARS.test(name)) {
    throw new ValidationError(
      `${what} name must be 1..${MAX_NAME} characters without control characters.`,
    );
  }
  return name;
}

function validRoomId(id: string): string {
  if (!ROOM_ID.test(id)) throw new ValidationError(`Invalid room id "${id}".`);
  return id;
}

function validChannelAddress(address: string): string {
  if (!CHANNEL_ADDRESS.test(address)) {
    throw new ValidationError(`Invalid channel address "${address}".`);
  }
  return address;
}

function decodedName(value: unknown): string {
  return typeof value === 'string' ? decodeRegaName(value) : '';
}

function okOf(raw: unknown, label: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new ClientError(`${label}: unexpected answer from the CCU.`);
  return raw;
}

function toRoom(entry: Record<string, unknown>): HmRoom | null {
  const id = entry['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  const channels = Array.isArray(entry['channels'])
    ? entry['channels'].filter((c): c is string => typeof c === 'string' && c !== '')
    : [];
  return { id: String(id), name: decodedName(entry['name']), channels };
}

export class CcuTopology {
  readonly #rega: RegaScriptRunner;

  public constructor(rega: RegaScriptRunner) {
    this.#rega = rega;
  }

  /** Rename a device, and with `renameChannels` every channel to `<name>:<index>`. */
  public async renameDevice(
    address: string,
    rawName: string,
    renameChannels: boolean,
  ): Promise<HmDeviceRename> {
    if (!DEVICE_ADDRESS.test(address)) {
      throw new ValidationError(`Invalid device address "${address}".`);
    }
    const name = validName(rawName, 'Device');
    const label = 'ReGa.runScript(renameDevice)';
    const answer = okOf(
      await this.#rega(label, RENAME_DEVICE, {
        address,
        name,
        channels: renameChannels ? '1' : '0',
      }),
      label,
    );
    if (answer['ok'] !== true) throw new ValidationError(`Unknown device "${address}".`);
    const channels: HmNamedObject[] = Array.isArray(answer['channels'])
      ? answer['channels'].filter(isRecord).flatMap((entry) => {
          const channelAddress = entry['address'];
          return typeof channelAddress === 'string' && channelAddress !== ''
            ? [{ address: channelAddress, name: decodedName(entry['name']) }]
            : [];
        })
      : [];
    return { device: { address, name: decodedName(answer['name']) }, channels };
  }

  /** Rename one channel; resolves with the name the CCU stored. */
  public async renameChannel(address: string, rawName: string): Promise<HmNamedObject> {
    validChannelAddress(address);
    const name = validName(rawName, 'Channel');
    const label = 'ReGa.runScript(renameChannel)';
    const answer = okOf(await this.#rega(label, RENAME_CHANNEL, { address, name }), label);
    if (answer['ok'] !== true) throw new ValidationError(`Unknown channel "${address}".`);
    return { address, name: decodedName(answer['name']) };
  }

  /** Every room with its member channel addresses. */
  public async rooms(): Promise<HmRoom[]> {
    const raw = await this.#rega('ReGa.runScript(listRooms)', LIST_ROOMS);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecord).flatMap((entry) => {
      const room = toRoom(entry);
      return room === null ? [] : [room];
    });
  }

  /** Create an empty room; a room of the same name is a {@link ValidationError}. */
  public async createRoom(rawName: string): Promise<HmRoom> {
    const name = validName(rawName, 'Room');
    const label = 'ReGa.runScript(createRoom)';
    const answer = okOf(await this.#rega(label, CREATE_ROOM, { name }), label);
    if (answer['error'] === 'exists') {
      throw new ValidationError(`A room named "${name}" already exists.`);
    }
    const room = toRoom({ ...answer, channels: [] });
    if (room === null) throw new ClientError(`${label}: the CCU did not create the room.`);
    return room;
  }

  /** Rename a room by id. */
  public async renameRoom(id: string, rawName: string): Promise<void> {
    const name = validName(rawName, 'Room');
    const label = 'ReGa.runScript(renameRoom)';
    const answer = okOf(
      await this.#rega(label, RENAME_ROOM, { id: validRoomId(id), name }),
      label,
    );
    if (answer['ok'] !== true) throw new ValidationError(`Unknown room "${id}".`);
  }

  /** Delete a room by id; an unerasable room is a {@link ValidationError}. */
  public async deleteRoom(id: string): Promise<void> {
    const label = 'ReGa.runScript(deleteRoom)';
    const answer = okOf(await this.#rega(label, DELETE_ROOM, { id: validRoomId(id) }), label);
    if (answer['ok'] === true) return;
    throw new ValidationError(
      answer['reason'] === 'unerasable'
        ? `Room "${id}" cannot be deleted (the CCU marks it unerasable).`
        : `Unknown room "${id}".`,
    );
  }

  /** Add a channel (by address) to a room. */
  public async addChannelToRoom(id: string, channelAddress: string): Promise<void> {
    await this.#roomChannel(id, channelAddress, 'add');
  }

  /** Remove a channel (by address) from a room. */
  public async removeChannelFromRoom(id: string, channelAddress: string): Promise<void> {
    await this.#roomChannel(id, channelAddress, 'remove');
  }

  async #roomChannel(id: string, channelAddress: string, op: 'add' | 'remove'): Promise<void> {
    const label = `ReGa.runScript(roomChannel ${op})`;
    const answer = okOf(
      await this.#rega(label, ROOM_CHANNEL, {
        id: validRoomId(id),
        address: validChannelAddress(channelAddress),
        op,
      }),
      label,
    );
    if (answer['ok'] === true) return;
    throw new ValidationError(
      answer['reason'] === 'channel'
        ? `Unknown channel "${channelAddress}".`
        : `Unknown room "${id}".`,
    );
  }
}
