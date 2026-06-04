import { describe, it, expect } from 'vitest';
import { HubFetcher } from '../../../../src/central/hub/hub-fetcher.js';
import { HubValueType } from '../../../../src/central/hub/sysvar.js';
import { JsonRpcMethod } from '../../../../src/transport/jsonrpc/methods.js';
import { ValidationError } from '../../../../src/support/errors.js';
import { GET_ROOMS_FUNCTIONS } from '../../../../src/central/rega/scripts.js';

interface PostRecord {
  method: string;
  params?: Record<string, unknown>;
  opts?: { sessionId?: string };
}

/**
 * Fake JSON-RPC client. Routes by method (and, for ReGa, by recognising the
 * script body) to canned results. ReGa results are returned as JSON **strings**
 * inside the `{ result }` envelope to exercise the runner's parse path.
 */
class FakeClient {
  public readonly posts: PostRecord[] = [];

  public constructor(
    private readonly handlers: Record<string, (params?: Record<string, unknown>) => unknown>,
  ) {}

  public async post(
    method: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string },
  ): Promise<unknown> {
    this.posts.push({ method, params, opts });
    const handler = this.handlers[method];
    return handler ? handler(params) : undefined;
  }
}

function makeFetcher(client: FakeClient, sessionId: string | undefined = 'sid'): HubFetcher {
  return new HubFetcher({ client, getSessionId: () => sessionId });
}

describe('HubFetcher.fetchSystemVariables', () => {
  it('merges getAll with ReGa descriptions and derives writable from the HAHM marker', async () => {
    const client = new FakeClient({
      [JsonRpcMethod.SYSVAR_GET_ALL]: () => [
        {
          id: '1',
          name: 'Presence',
          type: 'LOGIC',
          value: 'true',
          unit: '',
          isInternal: false,
          valueList: '',
        },
        {
          id: '2',
          name: 'Temp',
          type: 'FLOAT',
          value: '21.5',
          unit: '°C',
          isInternal: false,
        },
        {
          id: '3',
          name: 'Mode',
          type: 'LIST',
          value: '1',
          isInternal: true,
          valueList: 'auto;manual;boost',
        },
      ],
      // ReGa descriptions: only var 1 carries the HAHM marker → writable.
      [JsonRpcMethod.REGA_RUN_SCRIPT]: () =>
        JSON.stringify([
          { id: '1', description: 'Some HAHM note' },
          { id: '2', description: 'plain sensor' },
        ]),
    });
    const fetcher = makeFetcher(client);

    const vars = await fetcher.fetchSystemVariables();
    expect(vars).toHaveLength(3);

    const presence = vars.find((v) => v.id === '1');
    expect(presence?.type).toBe(HubValueType.LOGIC);
    expect(presence?.value).toBe(true);
    expect(presence?.writable).toBe(true);

    const temp = vars.find((v) => v.id === '2');
    expect(temp?.type).toBe(HubValueType.FLOAT);
    expect(temp?.value).toBe(21.5);
    expect(temp?.unit).toBe('°C');
    expect(temp?.writable).toBe(false);

    const mode = vars.find((v) => v.id === '3');
    expect(mode?.type).toBe(HubValueType.LIST);
    expect(mode?.value).toBe(1);
    expect(mode?.valueList).toEqual(['auto', 'manual', 'boost']);
    expect(mode?.isInternal).toBe(true);
    // No description for id 3 → tolerated, writable defaults false.
    expect(mode?.writable).toBe(false);
  });
});

describe('HubFetcher.getSystemVariable', () => {
  it('reads a value by name via SysVar.getValueByName', async () => {
    const client = new FakeClient({
      [JsonRpcMethod.SYSVAR_GET_VALUE_BY_NAME]: (params) => `read:${String(params?.name)}`,
    });
    const fetcher = makeFetcher(client);
    const value = await fetcher.getSystemVariable('Temp');
    expect(value).toBe('read:Temp');
    expect(client.posts[0]?.method).toBe(JsonRpcMethod.SYSVAR_GET_VALUE_BY_NAME);
    expect(client.posts[0]?.params).toMatchObject({ name: 'Temp' });
  });
});

describe('HubFetcher.setSystemVariable', () => {
  it('dispatches a boolean to SysVar.setBool with 1/0', async () => {
    const client = new FakeClient({ [JsonRpcMethod.SYSVAR_SET_BOOL]: () => true });
    const fetcher = makeFetcher(client);
    await fetcher.setSystemVariable('Presence', true);
    expect(client.posts[0]?.method).toBe(JsonRpcMethod.SYSVAR_SET_BOOL);
    expect(client.posts[0]?.params).toMatchObject({ name: 'Presence', value: 1 });
    await fetcher.setSystemVariable('Presence', false);
    expect(client.posts[1]?.params).toMatchObject({ name: 'Presence', value: 0 });
  });

  it('dispatches a number to SysVar.setFloat', async () => {
    const client = new FakeClient({ [JsonRpcMethod.SYSVAR_SET_FLOAT]: () => true });
    const fetcher = makeFetcher(client);
    await fetcher.setSystemVariable('Temp', 22.5);
    expect(client.posts[0]?.method).toBe(JsonRpcMethod.SYSVAR_SET_FLOAT);
    expect(client.posts[0]?.params).toMatchObject({ name: 'Temp', value: 22.5 });
  });

  it('dispatches a string to the ReGa SET_SYSTEM_VARIABLE script with substituted params', async () => {
    let capturedScript = '';
    const client = new FakeClient({
      [JsonRpcMethod.REGA_RUN_SCRIPT]: (params) => {
        capturedScript = String(params?.script);
        return '{}';
      },
    });
    const fetcher = makeFetcher(client);
    await fetcher.setSystemVariable('Greeting', 'say "hi"');
    expect(client.posts[0]?.method).toBe(JsonRpcMethod.REGA_RUN_SCRIPT);
    expect(capturedScript).toContain('Greeting');
    // The quote in the value is ReGa-escaped during substitution.
    expect(capturedScript).toContain('say \\"hi\\"');
  });

  it('rejects a null value with ValidationError', async () => {
    const client = new FakeClient({});
    const fetcher = makeFetcher(client);
    await expect(fetcher.setSystemVariable('X', null)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('HubFetcher.fetchPrograms', () => {
  it('maps fields and coerces isActive/isInternal to bool', async () => {
    const client = new FakeClient({
      [JsonRpcMethod.PROGRAM_GET_ALL]: () => [
        {
          id: '100',
          name: 'Morning',
          isActive: 'true',
          isInternal: 'false',
          lastExecuteTime: '2026-06-04 07:00:00',
        },
        { id: '101', name: 'Away', isActive: false, isInternal: true },
      ],
    });
    const fetcher = makeFetcher(client);
    const programs = await fetcher.fetchPrograms();
    expect(programs).toHaveLength(2);
    expect(programs[0]).toEqual({
      id: '100',
      name: 'Morning',
      isActive: true,
      isInternal: false,
      lastExecuteTime: '2026-06-04 07:00:00',
    });
    expect(programs[1]).toMatchObject({ id: '101', isActive: false, isInternal: true });
    expect(programs[1]?.lastExecuteTime).toBeUndefined();
  });
});

describe('HubFetcher.runProgram', () => {
  it('posts Program.execute with the id', async () => {
    const client = new FakeClient({ [JsonRpcMethod.PROGRAM_EXECUTE]: () => true });
    const fetcher = makeFetcher(client);
    await fetcher.runProgram('100');
    expect(client.posts[0]?.method).toBe(JsonRpcMethod.PROGRAM_EXECUTE);
    expect(client.posts[0]?.params).toMatchObject({ id: '100' });
  });
});

describe('HubFetcher.setProgramActive', () => {
  it('posts the ReGa SET_PROGRAM_STATE script with state 1/0', async () => {
    const scripts: string[] = [];
    const client = new FakeClient({
      [JsonRpcMethod.REGA_RUN_SCRIPT]: (params) => {
        scripts.push(String(params?.script));
        return '{}';
      },
    });
    const fetcher = makeFetcher(client);
    await fetcher.setProgramActive('100', true);
    await fetcher.setProgramActive('100', false);
    expect(scripts[0]).toContain('100');
    expect(scripts[0]).toMatch(/Active\(1\)/);
    expect(scripts[1]).toMatch(/Active\(0\)/);
  });
});

describe('HubFetcher.fetchRoomsFunctions', () => {
  it('parses and latin1-decodes names into Maps keyed by channel address', async () => {
    const client = new FakeClient({
      [JsonRpcMethod.REGA_RUN_SCRIPT]: (params) => {
        // Only respond when it's the rooms/functions script.
        expect(String(params?.script)).toBe(GET_ROOMS_FUNCTIONS);
        return JSON.stringify({
          rooms: { 'ABC123:1': ['Cucina%20caff%E8'], 'ABC123:2': ['Salone'] },
          functions: { 'ABC123:1': ['Luce'] },
        });
      },
    });
    const fetcher = makeFetcher(client);
    const { rooms, functions } = await fetcher.fetchRoomsFunctions();
    expect(rooms.get('ABC123:1')).toEqual(['Cucina caffè']);
    expect(rooms.get('ABC123:2')).toEqual(['Salone']);
    expect(functions.get('ABC123:1')).toEqual(['Luce']);
    expect(functions.has('ABC123:2')).toBe(false);
  });

  it('tolerates an empty result', async () => {
    const client = new FakeClient({
      [JsonRpcMethod.REGA_RUN_SCRIPT]: () => JSON.stringify({ rooms: {}, functions: {} }),
    });
    const fetcher = makeFetcher(client);
    const { rooms, functions } = await fetcher.fetchRoomsFunctions();
    expect(rooms.size).toBe(0);
    expect(functions.size).toBe(0);
  });
});
