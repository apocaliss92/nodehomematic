/**
 * Read-only ReGa side of the key event diagnosis (see
 * `../rega/key-diagnosis.ts`), over `ReGa.runScript`. The answer arrives as
 * `unknown` and is narrowed here; a field the CCU left empty is `null`.
 */
import { ClientError, ValidationError } from '../../support/errors.js';
import { buildDiagnoseKeyEvents } from '../rega/key-diagnosis.js';
import { decodeRegaName } from '../rega/rega-runner.js';
import type {
  HmKeyRegaChannel,
  HmKeyRegaDatapoint,
  HmKeyRegaProgram,
  HmKeyRegaState,
} from '../../api/types.js';
import type { RegaScriptRunner } from './ccu-topology.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A non-empty string field, else `null`. */
function str(entry: Record<string, unknown>, key: string): string | null {
  const value = entry[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A name field: `UriEncode`d by the script. */
function name(entry: Record<string, unknown>, key: string): string | null {
  const value = str(entry, key);
  return value === null ? null : decodeRegaName(value);
}

/** ReGa prints a boolean as `true` / `false`; anything else (empty included) is unknown. */
function bool(entry: Record<string, unknown>, key: string): boolean | null {
  const value = str(entry, key);
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

/** ReGa epoch seconds as epoch ms; `0` / empty / non-numeric is `null` (never happened). */
function epochMs(entry: Record<string, unknown>, key: string): number | null {
  const value = str(entry, key);
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function datapoint(entry: Record<string, unknown>): HmKeyRegaDatapoint | null {
  const dpName = str(entry, 'name');
  if (dpName === null) return null;
  if (entry['exists'] !== true) {
    return {
      name: dpName,
      exists: false,
      id: null,
      value: null,
      timestamp: null,
      lastTimestamp: null,
    };
  }
  return {
    name: dpName,
    exists: true,
    id: str(entry, 'id'),
    value: name(entry, 'value'),
    timestamp: epochMs(entry, 'timestampSeconds'),
    lastTimestamp: epochMs(entry, 'lastTimestampSeconds'),
  };
}

function channel(entry: Record<string, unknown>): HmKeyRegaChannel | null {
  const address = str(entry, 'address');
  if (address === null) return null;
  const datapoints = records(entry['datapoints']).flatMap((dp) => {
    const parsed = datapoint(dp);
    return parsed === null ? [] : [parsed];
  });
  const found = entry['found'] === true;
  return {
    address,
    found,
    id: found ? str(entry, 'id') : null,
    name: found ? name(entry, 'name') : null,
    visible: found ? bool(entry, 'visible') : null,
    enabled: found ? bool(entry, 'enabled') : null,
    readyConfig: found ? bool(entry, 'readyConfig') : null,
    lastActionAt: found ? epochMs(entry, 'lastActionSeconds') : null,
    datapoints,
  };
}

function program(entry: Record<string, unknown>): HmKeyRegaProgram | null {
  const id = str(entry, 'id');
  if (id === null) return null;
  const datapoints = Array.isArray(entry['datapoints'])
    ? entry['datapoints'].filter((dp): dp is string => typeof dp === 'string')
    : [];
  return {
    id,
    name: name(entry, 'name') ?? '',
    active: bool(entry, 'active'),
    internal: bool(entry, 'internal'),
    lastExecutedAt: epochMs(entry, 'lastExecuteSeconds'),
    datapoints,
  };
}

export class CcuKeyDiagnosis {
  readonly #rega: RegaScriptRunner;

  public constructor(rega: RegaScriptRunner) {
    this.#rega = rega;
  }

  /**
   * Read the ReGa channel objects, key data points and referencing programs
   * for `channelAddresses` on `interfaceName` (`HmIP-RF`). Writes nothing.
   */
  public async read(
    interfaceName: string,
    channelAddresses: readonly string[],
  ): Promise<HmKeyRegaState> {
    if (channelAddresses.length === 0) {
      throw new ValidationError('The key diagnosis needs at least one channel.');
    }
    const label = 'ReGa.runScript(diagnoseKeyEvents)';
    const answer = await this.#rega(label, buildDiagnoseKeyEvents(interfaceName, channelAddresses));
    if (!isRecord(answer)) throw new ClientError(`${label}: unexpected answer from the CCU.`);
    return {
      channels: records(answer['channels']).flatMap((entry) => {
        const parsed = channel(entry);
        return parsed === null ? [] : [parsed];
      }),
      programs: records(answer['programs']).flatMap((entry) => {
        const parsed = program(entry);
        return parsed === null ? [] : [parsed];
      }),
    };
  }
}
