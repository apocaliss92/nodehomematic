/**
 * Hub fetcher: system variables, programs, and the rooms/functions mapping.
 *
 * Combines JSON-RPC (`SysVar.*`, `Program.*`) with ReGa scripts (descriptions,
 * string-sysvar writes, program enable/disable, rooms/functions). All CCU
 * responses arrive as `unknown` and are narrowed defensively before use.
 */
import type { HmValue } from '../../model/converter.js';
import { ValidationError } from '../../support/errors.js';
import { JsonRpcMethod } from '../../transport/jsonrpc/methods.js';
import { decodeRegaName, runScript, type RegaPostClient } from '../rega/rega-runner.js';
import {
  GET_ROOMS_FUNCTIONS,
  SET_PROGRAM_STATE,
  SET_SYSTEM_VARIABLE,
  SYSVAR_DESCRIPTIONS,
} from '../rega/scripts.js';
import type { HmProgramRecord } from './program.js';
import { normalizeType, parseSysVarValue, toBool, type SystemVariable } from './sysvar.js';

/** The description marker the CCU sets on extended (writable) system variables. */
const WRITABLE_MARKER = 'HAHM';

/** Constructor dependencies. The session id is read lazily so it can rotate. */
export interface HubFetcherOptions {
  readonly client: RegaPostClient;
  readonly getSessionId: () => string | undefined;
}

/** Read an object property as `unknown` after narrowing the container. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Coerce an unknown CCU scalar to a string (used for value/type fields). */
function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Coerce an unknown CCU flag (boolean or "true"/"false" string) to a boolean. */
function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return toBool(value);
  if (typeof value === 'number') return value !== 0;
  return false;
}

/** Coerce an unknown to a finite number, or undefined. */
function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** Narrow an unknown JSON-RPC result to an array of records. */
function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

/**
 * Fetches and writes hub-level entities. One instance is bound to a JSON-RPC
 * client and a session-id getter; all methods are independently callable.
 */
export class HubFetcher {
  private readonly client: RegaPostClient;
  private readonly getSessionId: () => string | undefined;

  public constructor(options: HubFetcherOptions) {
    this.client = options.client;
    this.getSessionId = options.getSessionId;
  }

  private sid(): string | undefined {
    return this.getSessionId();
  }

  /**
   * Fetch all system variables and join them with their ReGa descriptions to
   * determine writability (the `HAHM` marker). Missing descriptions are
   * tolerated (such a variable is treated as read-only).
   */
  public async fetchSystemVariables(): Promise<SystemVariable[]> {
    const sid = this.sid();
    const rawAll = await this.client.post(JsonRpcMethod.SYSVAR_GET_ALL, undefined, sidOpts(sid));
    const entries = asRecordArray(rawAll);

    const descriptions = await this.fetchSysVarDescriptions();

    return entries.map((entry) => this.toSystemVariable(entry, descriptions));
  }

  /** Read a single system variable's raw value by name. */
  public async getSystemVariable(name: string): Promise<HmValue> {
    const sid = this.sid();
    const raw = await this.client.post(
      JsonRpcMethod.SYSVAR_GET_VALUE_BY_NAME,
      { name },
      sidOpts(sid),
    );
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      return raw;
    }
    if (raw === null || raw === undefined) return null;
    return asString(raw);
  }

  /**
   * Write a system variable, dispatching on the JS value type: boolean →
   * `SysVar.setBool` (1/0), number → `SysVar.setFloat`, string → ReGa
   * `SET_SYSTEM_VARIABLE`. A null value is rejected.
   */
  public async setSystemVariable(name: string, value: HmValue): Promise<void> {
    const sid = this.sid();
    if (value === null) {
      throw new ValidationError(`Cannot set system variable "${name}" to null`);
    }
    if (typeof value === 'boolean') {
      await this.client.post(
        JsonRpcMethod.SYSVAR_SET_BOOL,
        { name, value: value ? 1 : 0 },
        sidOpts(sid),
      );
      return;
    }
    if (typeof value === 'number') {
      await this.client.post(JsonRpcMethod.SYSVAR_SET_FLOAT, { name, value }, sidOpts(sid));
      return;
    }
    await runScript(this.client, sid, SET_SYSTEM_VARIABLE, { name, value });
  }

  /** Fetch all programs, coercing flags to booleans. */
  public async fetchPrograms(): Promise<HmProgramRecord[]> {
    const sid = this.sid();
    const raw = await this.client.post(JsonRpcMethod.PROGRAM_GET_ALL, undefined, sidOpts(sid));
    return asRecordArray(raw).map((entry) => {
      const lastExecuteTime = entry.lastExecuteTime;
      const record: HmProgramRecord = {
        id: asString(entry.id),
        name: asString(entry.name),
        isActive: asBool(entry.isActive),
        isInternal: asBool(entry.isInternal),
        ...(typeof lastExecuteTime === 'string' && lastExecuteTime !== ''
          ? { lastExecuteTime }
          : {}),
      };
      return record;
    });
  }

  /** Execute a program by id. */
  public async runProgram(id: string): Promise<void> {
    const sid = this.sid();
    await this.client.post(JsonRpcMethod.PROGRAM_EXECUTE, { id }, sidOpts(sid));
  }

  /** Enable/disable a program via the ReGa `SET_PROGRAM_STATE` script. */
  public async setProgramActive(id: string, active: boolean): Promise<void> {
    const sid = this.sid();
    await runScript(this.client, sid, SET_PROGRAM_STATE, { id, state: active ? 1 : 0 });
  }

  /**
   * Run the custom ReGa script to recover the rooms/functions mapping keyed by
   * channel address, decoding the latin1 `UriEncode`d names. Tolerates empty.
   */
  public async fetchRoomsFunctions(): Promise<{
    rooms: Map<string, string[]>;
    functions: Map<string, string[]>;
  }> {
    const sid = this.sid();
    const parsed = await runScript(this.client, sid, GET_ROOMS_FUNCTIONS);
    return {
      rooms: toDecodedMap(isRecord(parsed) ? parsed.rooms : undefined),
      functions: toDecodedMap(isRecord(parsed) ? parsed.functions : undefined),
    };
  }

  /** Build the `SYSVAR_DESCRIPTIONS` map: sysvar id → description text. */
  private async fetchSysVarDescriptions(): Promise<Map<string, string>> {
    const sid = this.sid();
    const out = new Map<string, string>();
    try {
      const parsed = await runScript(this.client, sid, SYSVAR_DESCRIPTIONS);
      for (const entry of asRecordArray(parsed)) {
        const id = asString(entry.id);
        if (id !== '') out.set(id, asString(entry.description));
      }
    } catch {
      // Descriptions are best-effort; without them everything is read-only.
    }
    return out;
  }

  /** Map a single `SysVar.getAll` entry to a {@link SystemVariable}. */
  private toSystemVariable(
    entry: Record<string, unknown>,
    descriptions: Map<string, string>,
  ): SystemVariable {
    const id = asString(entry.id);
    const rawValue = asString(entry.value);
    const type = normalizeType(asString(entry.type), rawValue);
    const description = descriptions.get(id);
    const unit = asString(entry.unit);
    const valueListRaw = asString(entry.valueList);
    const valueList =
      valueListRaw !== '' ? valueListRaw.split(';').map((s) => s.trim()) : undefined;
    const min = asOptionalNumber(entry.minValue);
    const max = asOptionalNumber(entry.maxValue);

    return {
      id,
      name: asString(entry.name),
      type,
      value: parseSysVarValue(type, rawValue),
      ...(unit !== '' ? { unit } : {}),
      isInternal: asBool(entry.isInternal),
      writable: description !== undefined && description.includes(WRITABLE_MARKER),
      ...(valueList ? { valueList } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    };
  }
}

/** Build the per-call options object (omitted entirely when no session). */
function sidOpts(sid: string | undefined): { sessionId?: string } | undefined {
  return sid !== undefined ? { sessionId: sid } : undefined;
}

/** Turn `{ addr: [encName,...] }` into a `Map<addr, decodedName[]>`. */
function toDecodedMap(value: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!isRecord(value)) return map;
  for (const [addr, names] of Object.entries(value)) {
    if (Array.isArray(names)) {
      map.set(
        addr,
        names.filter((n): n is string => typeof n === 'string').map((n) => decodeRegaName(n)),
      );
    }
  }
  return map;
}
