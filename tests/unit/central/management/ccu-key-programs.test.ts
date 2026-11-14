import { describe, it, expect } from 'vitest';
import {
  CcuKeyPrograms,
  interfaceNameOf,
} from '../../../../src/central/management/ccu-key-programs.js';
import { runScript, type RegaPostClient } from '../../../../src/central/rega/rega-runner.js';
import {
  GET_KEY_EVENT_PROGRAM,
  REMOVE_KEY_EVENT_PROGRAM,
  buildDeleteProgram,
  buildEnsureKeyEventProgram,
} from '../../../../src/central/rega/key-event-program.js';
import { ClientError, ValidationError } from '../../../../src/support/errors.js';
import { JsonRpcMethod } from '../../../../src/transport/jsonrpc/methods.js';

interface Call {
  readonly label: string;
  readonly script: string;
  readonly params: Record<string, string | number> | undefined;
}

/** A KeyPrograms service whose ReGa runner records the call and answers `answer`. */
function service(answer: unknown): { keyPrograms: CcuKeyPrograms; calls: Call[] } {
  const calls: Call[] = [];
  const keyPrograms = new CcuKeyPrograms((label, script, params) => {
    calls.push({ label, script, params });
    return Promise.resolve(answer);
  });
  return { keyPrograms, calls };
}

/** The script text the CCU would receive after `##key##` substitution. */
async function substituted(body: string, params: Record<string, string | number>): Promise<string> {
  const posts: Array<Record<string, unknown> | undefined> = [];
  const client: RegaPostClient = {
    post: (method, p) => {
      expect(method).toBe(JsonRpcMethod.REGA_RUN_SCRIPT);
      posts.push(p);
      return Promise.resolve('{}');
    },
  };
  await runScript(client, 'sid', body, params);
  const script = posts[0]?.['script'];
  if (typeof script !== 'string') throw new Error('no script posted');
  return script;
}

const DPS = [
  'HmIP-RF.00315F298E5093:1.PRESS_SHORT',
  'HmIP-RF.00315F298E5093:1.PRESS_LONG',
  'HmIP-RF.00315F298E5093:2.PRESS_SHORT',
];

describe('key event program scripts', () => {
  it('ensure: the substituted script matches the fixture', async () => {
    expect(
      await substituted(buildEnsureKeyEventProgram(DPS), { name: 'CamStack: Hall events' }),
    ).toMatchSnapshot();
  });

  it('ensure: one single condition per data point, trigger on update, on the channel', () => {
    const script = buildEnsureKeyEventProgram(DPS);
    expect(script.match(/oSc = oCnd\.CndAddSingle\(\);/g)).toHaveLength(3);
    expect(script.match(/oSc\.ConditionType2\(13\);/g)).toHaveLength(3);
    expect(script).toContain('oSc.LeftVal(oDp2.ID());');
    expect(script).toContain('oSc.ConditionChannel(oDp2.Channel());');
    expect(script).toContain('dom.GetObject("HmIP-RF.00315F298E5093:2.PRESS_SHORT")');
    // Nothing is written before every data point is known.
    expect(script.indexOf('if (sMissing != "")')).toBeLessThan(script.indexOf('CreateObject'));
  });

  it('escapes a name with quotes and backslashes', async () => {
    const name = 'Kitchen "main" \\ events';
    for (const body of [
      buildEnsureKeyEventProgram(DPS),
      REMOVE_KEY_EVENT_PROGRAM,
      GET_KEY_EVENT_PROGRAM,
    ]) {
      const script = await substituted(body, { name });
      expect(script).toContain('string sName = "Kitchen \\"main\\" \\\\ events";');
      expect(script).not.toContain('##name##');
    }
  });

  it('remove and get: substituted script fixtures', async () => {
    expect(await substituted(REMOVE_KEY_EVENT_PROGRAM, { name: 'P' })).toMatchSnapshot();
    expect(await substituted(GET_KEY_EVENT_PROGRAM, { name: 'P' })).toMatchSnapshot();
  });

  it('rejects a data point that could carry script text', () => {
    expect(() => buildEnsureKeyEventProgram(['HmIP-RF.X:1.PRESS_SHORT");evil("'])).toThrow(
      ValidationError,
    );
    expect(() => buildEnsureKeyEventProgram([])).toThrow(ValidationError);
  });

  it('deleteProgram deletes only an id listed in ID_PROGRAMS', () => {
    const script = buildDeleteProgram('10655');
    expect(script).toContain('! nodehomematic:deleteProgram');
    expect(script).toContain('ID_PROGRAMS');
    expect(script).toContain('10655');
    const listed = script.indexOf('EnumUsedIDs()');
    const deleted = script.indexOf('dom.DeleteObject');
    const removed = script.indexOf('{\\"removed\\":true}');
    const kept = script.indexOf('{\\"removed\\":false}');
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(listed).toBeLessThan(deleted);
    expect(deleted).toBeLessThan(removed);
    expect(removed).toBeLessThan(kept);
  });

  it('rejects a program id that is not digits before it reaches the script', () => {
    expect(() => buildDeleteProgram('10655; dom.DeleteObject(1)')).toThrow(ValidationError);
    expect(() => buildDeleteProgram('')).toThrow(ValidationError);
    expect(() => buildDeleteProgram('12a')).toThrow(ValidationError);
    expect(() => buildDeleteProgram(' 10655')).toThrow(ValidationError);
  });

  it('refuses a duplicate name before creating, deleting or reading', () => {
    const scripts = [
      buildEnsureKeyEventProgram(DPS),
      REMOVE_KEY_EVENT_PROGRAM,
      GET_KEY_EVENT_PROGRAM,
    ];
    for (const script of scripts) {
      expect(script).toContain('iMatches');
      const guard = script.indexOf('\\"error\\":\\"duplicate\\"');
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(script).toContain('\\"ids\\"');
      const mutation = Math.min(
        ...['CreateObject', 'DeleteObject', '"found"'].map((token) => {
          const at = script.indexOf(token);
          return at === -1 ? Number.POSITIVE_INFINITY : at;
        }),
      );
      expect(guard).toBeLessThan(mutation);
    }
  });
});

describe('CcuKeyPrograms', () => {
  it('ensure builds <interface>.<channel>.<param> for every channel and parameter', async () => {
    const { keyPrograms, calls } = service({ programId: '12345', created: true });
    const result = await keyPrograms.ensure('HmIP-RF', {
      name: ' Hall ',
      channelAddresses: ['DEV:1', 'DEV:2'],
    });
    expect(result).toEqual({ programId: '12345', created: true });
    expect(calls[0]?.params).toEqual({ name: 'Hall' });
    expect(calls[0]?.script).toContain('dom.GetObject("HmIP-RF.DEV:1.PRESS_SHORT")');
    expect(calls[0]?.script).toContain('dom.GetObject("HmIP-RF.DEV:2.PRESS_LONG")');
  });

  it('ensure honours a parameter subset', async () => {
    const { keyPrograms, calls } = service({ programId: '1', created: false });
    await keyPrograms.ensure('HmIP-RF', {
      name: 'P',
      channelAddresses: ['DEV:1'],
      parameters: ['PRESS_LONG'],
    });
    expect(calls[0]?.script).not.toContain('PRESS_SHORT');
    expect(calls[0]?.script).toContain('HmIP-RF.DEV:1.PRESS_LONG');
  });

  it('ensure names a missing data point', async () => {
    const { keyPrograms } = service({
      error: 'datapoint',
      missing: ['HmIP-RF.DEV:9.PRESS_SHORT'],
    });
    await expect(
      keyPrograms.ensure('HmIP-RF', { name: 'P', channelAddresses: ['DEV:9'] }),
    ).rejects.toThrow(/HmIP-RF\.DEV:9\.PRESS_SHORT/);
  });

  it('ensure refuses an unexpected answer and bad input', async () => {
    await expect(
      service({ nope: true }).keyPrograms.ensure('HmIP-RF', {
        name: 'P',
        channelAddresses: ['DEV:1'],
      }),
    ).rejects.toThrow(ClientError);
    await expect(
      service('x').keyPrograms.ensure('HmIP-RF', { name: 'P', channelAddresses: ['DEV'] }),
    ).rejects.toThrow(ValidationError);
    await expect(
      service({}).keyPrograms.ensure('HmIP-RF', { name: '  ', channelAddresses: ['DEV:1'] }),
    ).rejects.toThrow(ValidationError);
  });

  it('delete removes a program by id and refuses a non-digit id before ReGa', async () => {
    const deleted = service({ removed: true });
    expect(await deleted.keyPrograms.delete('10655')).toEqual({ removed: true });
    expect(deleted.calls[0]?.label).toBe('ReGa.runScript(deleteProgram)');
    expect(deleted.calls[0]?.script).toContain('10655');
    expect(deleted.calls[0]?.script).toContain('dom.DeleteObject');
    expect(await service({ removed: false }).keyPrograms.delete('9')).toEqual({ removed: false });
    await expect(service({}).keyPrograms.delete('1')).rejects.toThrow(ClientError);
    const refused = service({ removed: true });
    await expect(refused.keyPrograms.delete('1; x')).rejects.toThrow(ValidationError);
    expect(refused.calls).toEqual([]);
  });

  it('remove reports whether a program was deleted', async () => {
    expect(await service({ removed: true }).keyPrograms.remove('P')).toEqual({ removed: true });
    expect(await service({ removed: false }).keyPrograms.remove('P')).toEqual({ removed: false });
    await expect(service({}).keyPrograms.remove('P')).rejects.toThrow(ClientError);
  });

  it('ensure, remove and get name a duplicate and point at deleteProgram', async () => {
    const answer = { error: 'duplicate', ids: ['10655', '10668'] };
    const name = 'CamStack: Pulsante bagno camerette events';
    const runs = [
      (): Promise<unknown> =>
        service(answer).keyPrograms.ensure('HmIP-RF', {
          name,
          channelAddresses: ['DEV:1'],
        }),
      (): Promise<unknown> => service(answer).keyPrograms.remove(name),
      (): Promise<unknown> => service(answer).keyPrograms.get(name),
    ];
    for (const run of runs) {
      await expect(run()).rejects.toThrow(ValidationError);
      await expect(run()).rejects.toThrow(/CamStack: Pulsante bagno camerette events/);
      await expect(run()).rejects.toThrow(/10655/);
      await expect(run()).rejects.toThrow(/10668/);
      await expect(run()).rejects.toThrow(/deleteProgram\(id\)/);
    }
  });

  it('get returns the distinct channels, or null when absent', async () => {
    const found = service({
      found: true,
      programId: '77',
      datapoints: DPS,
    });
    expect(await found.keyPrograms.get('P')).toEqual({
      programId: '77',
      channelAddresses: ['00315F298E5093:1', '00315F298E5093:2'],
    });
    expect(await service({ found: false }).keyPrograms.get('P')).toBeNull();
    await expect(service({ found: true }).keyPrograms.get('P')).rejects.toThrow(ClientError);
  });
});

describe('interfaceNameOf', () => {
  it('derives the CCU interface from the library interface id', () => {
    expect(interfaceNameOf('ccu-HmIP-RF')).toBe('HmIP-RF');
    expect(interfaceNameOf('ccu-BidCos-RF')).toBe('BidCos-RF');
    expect(() => interfaceNameOf('ccu-Other')).toThrow(ValidationError);
  });
});
