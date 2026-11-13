/**
 * The fake CCU's ReGa names-and-rooms model, answering the `! nodehomematic:<op>`
 * scripts of `src/central/rega/scripts.ts`. It parses each script's
 * `string sX = "...";` input lines (undoing the runner's ReGa escaping) and
 * answers with the JSON the real script writes, names `UriEncode`d over latin1.
 */
import type { DeviceDescription } from '../../../src/transport/xmlrpc/types.js';

/** One fake room. */
export interface FakeRoom {
  readonly id: string;
  readonly name: string;
  readonly channels: readonly string[];
}

const OP = /^! nodehomematic:(\w+)/;
const STRING_INPUT = /^string (s\w+) = "((?:[^"\\]|\\.)*)";$/gm;

/** ReGa `UriEncode` over latin1 bytes (what `decodeRegaName` undoes). */
function uriEncode(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += /[A-Za-z0-9]/.test(ch) ? ch : `%${(code & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function inputs(script: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of script.matchAll(STRING_INPUT)) {
    out.set(match[1] ?? '', (match[2] ?? '').replace(/\\(.)/g, '$1'));
  }
  return out;
}

export class FakeRegaTopology {
  readonly #devices: readonly DeviceDescription[];
  readonly #names = new Map<string, string>();
  readonly #rooms = new Map<string, { name: string; channels: string[] }>();
  readonly #unerasable = new Set<string>();
  /** Every op seen, in order. */
  readonly ops: string[] = [];
  #nextRoomId = 9000;

  public constructor(
    devices: readonly DeviceDescription[],
    names: ReadonlyMap<string, string>,
    rooms: readonly FakeRoom[],
  ) {
    this.#devices = devices;
    for (const [address, name] of names) this.#names.set(address, name);
    for (const room of rooms) {
      this.#rooms.set(room.id, { name: room.name, channels: [...room.channels] });
    }
  }

  /** The name the fake ReGa holds for a device/channel address. */
  public nameOf(address: string): string | undefined {
    return this.#names.get(address);
  }

  /** Snapshot of the rooms. */
  public rooms(): FakeRoom[] {
    return [...this.#rooms].map(([id, room]) => ({
      id,
      name: room.name,
      channels: [...room.channels],
    }));
  }

  /** Mark a room unerasable (as the CCU does for some built-in objects). */
  public markUnerasable(id: string): void {
    this.#unerasable.add(id);
  }

  /** `undefined` when the script is not one of ours. */
  public run(script: string): string | undefined {
    const op = OP.exec(script)?.[1];
    if (op === undefined) return undefined;
    this.ops.push(op);
    const input = inputs(script);
    const get = (key: string): string => input.get(key) ?? '';
    switch (op) {
      case 'renameDevice':
        return this.#renameDevice(get('sAddress'), get('sName'), get('sChannels') === '1');
      case 'renameChannel':
        return this.#renameChannel(get('sAddress'), get('sName'));
      case 'listRooms':
        return JSON.stringify(
          this.rooms().map((room) => ({ ...room, name: uriEncode(room.name) })),
        );
      case 'createRoom':
        return this.#createRoom(get('sName'));
      case 'renameRoom': {
        const room = this.#rooms.get(get('sRoomId'));
        if (room === undefined) return '{"ok":false}';
        room.name = get('sName');
        return '{"ok":true}';
      }
      case 'deleteRoom':
        return this.#deleteRoom(get('sRoomId'));
      case 'roomChannel':
        return this.#roomChannel(get('sRoomId'), get('sAddress'), get('sOp'));
      default:
        throw new Error(`fake ReGa: unknown op ${op}`);
    }
  }

  #isDevice(address: string): boolean {
    return this.#devices.some((d) => d.ADDRESS === address && d.PARENT === undefined);
  }

  #isChannel(address: string): boolean {
    return this.#devices.some((d) => d.ADDRESS === address && d.PARENT !== undefined);
  }

  #renameDevice(address: string, name: string, channels: boolean): string {
    if (!this.#isDevice(address)) return '{"ok":false}';
    this.#names.set(address, name);
    const renamed = channels
      ? this.#devices
          .filter((d) => d.PARENT === address)
          .map((d) => {
            const index = d.ADDRESS.slice(d.ADDRESS.lastIndexOf(':') + 1);
            const channelName = `${name}:${index}`;
            this.#names.set(d.ADDRESS, channelName);
            return { address: d.ADDRESS, name: uriEncode(channelName) };
          })
      : [];
    return JSON.stringify({ ok: true, name: uriEncode(name), channels: renamed });
  }

  #renameChannel(address: string, name: string): string {
    if (!this.#isChannel(address)) return '{"ok":false}';
    this.#names.set(address, name);
    return JSON.stringify({ ok: true, name: uriEncode(name) });
  }

  #createRoom(name: string): string {
    if ([...this.#rooms.values()].some((room) => room.name === name)) {
      return '{"error":"exists"}';
    }
    const id = String(this.#nextRoomId);
    this.#nextRoomId += 1;
    this.#rooms.set(id, { name, channels: [] });
    return JSON.stringify({ id, name: uriEncode(name) });
  }

  #deleteRoom(id: string): string {
    if (!this.#rooms.has(id)) return '{"ok":false,"reason":"room"}';
    if (this.#unerasable.has(id)) return '{"ok":false,"reason":"unerasable"}';
    this.#rooms.delete(id);
    return '{"ok":true}';
  }

  #roomChannel(id: string, address: string, op: string): string {
    const room = this.#rooms.get(id);
    if (room === undefined) return '{"ok":false,"reason":"room"}';
    if (!this.#isChannel(address)) return '{"ok":false,"reason":"channel"}';
    if (op === 'add') {
      if (!room.channels.includes(address)) room.channels.push(address);
    } else {
      room.channels = room.channels.filter((c) => c !== address);
    }
    return '{"ok":true}';
  }
}
