/**
 * The CCU program that makes a HmIP device send key presses to the access
 * point (see `../rega/key-event-program.ts`), over `ReGa.runScript`. Inputs are
 * validated before a script runs; every answer arrives as `unknown` and is
 * narrowed here.
 */
import { Interface } from '../../support/constants.js';
import { ClientError, ValidationError } from '../../support/errors.js';
import {
  GET_KEY_EVENT_PROGRAM,
  REMOVE_KEY_EVENT_PROGRAM,
  buildEnsureKeyEventProgram,
} from '../rega/key-event-program.js';
import type {
  HmKeyEventParameter,
  HmKeyEventProgram,
  HmKeyEventProgramInput,
  HmKeyEventProgramResult,
} from '../../api/types.js';
import type { RegaScriptRunner } from './ccu-topology.js';

const CHANNEL_ADDRESS = /^[0-9A-Za-z_-]+:\d+$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const MAX_NAME = 128;
const DEFAULT_PARAMETERS: readonly HmKeyEventParameter[] = ['PRESS_SHORT', 'PRESS_LONG'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new ClientError(`${label}: unexpected answer from the CCU.`);
  return raw;
}

function validName(raw: string): string {
  const name = raw.trim();
  if (name === '' || name.length > MAX_NAME || CONTROL_CHARS.test(name)) {
    throw new ValidationError(
      `Program name must be 1..${MAX_NAME} characters without control characters.`,
    );
  }
  return name;
}

/** The CCU interface name (`HmIP-RF`) a library interface id (`<central>-HmIP-RF`) ends with. */
export function interfaceNameOf(interfaceId: string): string {
  const match = (Object.values(Interface) as string[]).find((name) =>
    interfaceId.endsWith(`-${name}`),
  );
  if (match === undefined) {
    throw new ValidationError(`Cannot derive the CCU interface from "${interfaceId}".`);
  }
  return match;
}

export class CcuKeyPrograms {
  readonly #rega: RegaScriptRunner;

  public constructor(rega: RegaScriptRunner) {
    this.#rega = rega;
  }

  /**
   * Create or rewrite the program so its conditions are exactly
   * `channelAddresses` x `parameters`. `interfaceName` is the CCU interface the
   * channels live on (`HmIP-RF`).
   */
  public async ensure(
    interfaceName: string,
    input: HmKeyEventProgramInput,
  ): Promise<HmKeyEventProgramResult> {
    const name = validName(input.name);
    const parameters = input.parameters ?? DEFAULT_PARAMETERS;
    if (parameters.length === 0) throw new ValidationError('At least one key parameter is needed.');
    const datapoints = input.channelAddresses.flatMap((address) => {
      if (!CHANNEL_ADDRESS.test(address)) {
        throw new ValidationError(`Invalid channel address "${address}".`);
      }
      return parameters.map((param) => `${interfaceName}.${address}.${param}`);
    });
    const label = 'ReGa.runScript(ensureKeyEventProgram)';
    const answer = record(
      await this.#rega(label, buildEnsureKeyEventProgram(datapoints), { name }),
      label,
    );
    if (answer['error'] === 'datapoint') {
      const missing = Array.isArray(answer['missing']) ? answer['missing'].join(', ') : '?';
      throw new ValidationError(`The CCU has no such key data point: ${missing}.`);
    }
    const programId = answer['programId'];
    const created = answer['created'];
    if (typeof programId !== 'string' || programId === '' || typeof created !== 'boolean') {
      throw new ClientError(`${label}: the CCU did not return the program.`);
    }
    return { programId, created };
  }

  /** Delete the program by name; `removed: false` when it does not exist. */
  public async remove(rawName: string): Promise<{ removed: boolean }> {
    const name = validName(rawName);
    const label = 'ReGa.runScript(removeKeyEventProgram)';
    const answer = record(await this.#rega(label, REMOVE_KEY_EVENT_PROGRAM, { name }), label);
    if (typeof answer['removed'] !== 'boolean') {
      throw new ClientError(`${label}: unexpected answer from the CCU.`);
    }
    return { removed: answer['removed'] };
  }

  /** The program and the channels it listens to, or `null` when absent. */
  public async get(rawName: string): Promise<HmKeyEventProgram | null> {
    const name = validName(rawName);
    const label = 'ReGa.runScript(getKeyEventProgram)';
    const answer = record(await this.#rega(label, GET_KEY_EVENT_PROGRAM, { name }), label);
    if (answer['found'] !== true) return null;
    const programId = answer['programId'];
    if (typeof programId !== 'string' || programId === '') {
      throw new ClientError(`${label}: the CCU did not return the program id.`);
    }
    const datapoints = Array.isArray(answer['datapoints']) ? answer['datapoints'] : [];
    const channels = new Set<string>();
    for (const dp of datapoints) {
      if (typeof dp !== 'string') continue;
      const match = /\.([0-9A-Za-z_-]+:\d+)\.PRESS_(?:SHORT|LONG)$/.exec(dp);
      if (match?.[1] !== undefined) channels.add(match[1]);
    }
    return { programId, channelAddresses: [...channels] };
  }
}
