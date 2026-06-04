import { describe, it, expect } from 'vitest';
import {
  dispatch,
  SUPPORTED_METHODS,
  MethodNotFoundError,
} from '../../../../src/transport/callback-server/handlers.js';
import type { RawCallbackEvent } from '../../../../src/transport/callback-server/events.js';

function collect(): {
  events: RawCallbackEvent[];
  emit: (e: RawCallbackEvent) => void;
} {
  const events: RawCallbackEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

describe('callback handlers — event', () => {
  it('event(...) emits a normalized event and returns true', () => {
    const { events, emit } = collect();
    const result = dispatch(
      { methodName: 'event', params: ['MyCCU-HmIP-RF', 'VCU001:1', 'STATE', true] },
      { emit, listDevices: () => [] },
    );
    expect(result).toBe(true);
    expect(events).toEqual([
      {
        type: 'event',
        interfaceId: 'MyCCU-HmIP-RF',
        channelAddress: 'VCU001:1',
        parameter: 'STATE',
        value: true,
      },
    ]);
  });

  it('event with missing positional args throws (validation)', () => {
    const { emit } = collect();
    expect(() =>
      dispatch(
        { methodName: 'event', params: ['MyCCU-HmIP-RF', 'VCU001:1'] },
        { emit, listDevices: () => [] },
      ),
    ).toThrow();
  });
});

describe('callback handlers — device lifecycle', () => {
  it('newDevices(...) emits descriptions array', () => {
    const { events, emit } = collect();
    const descriptions = [{ ADDRESS: 'VCU001', TYPE: 'HmIP-FOO' }];
    const result = dispatch(
      { methodName: 'newDevices', params: ['MyCCU-HmIP-RF', descriptions] },
      { emit, listDevices: () => [] },
    );
    expect(result).toBe(true);
    expect(events[0]).toMatchObject({
      type: 'newDevices',
      interfaceId: 'MyCCU-HmIP-RF',
      descriptions,
    });
  });

  it('deleteDevices(...) emits addresses', () => {
    const { events, emit } = collect();
    dispatch(
      { methodName: 'deleteDevices', params: ['MyCCU-HmIP-RF', ['VCU001', 'VCU002']] },
      { emit, listDevices: () => [] },
    );
    expect(events[0]).toEqual({
      type: 'deleteDevices',
      interfaceId: 'MyCCU-HmIP-RF',
      addresses: ['VCU001', 'VCU002'],
    });
  });

  it('updateDevice(...) emits hint as number', () => {
    const { events, emit } = collect();
    dispatch(
      { methodName: 'updateDevice', params: ['MyCCU-HmIP-RF', 'VCU001', 1] },
      { emit, listDevices: () => [] },
    );
    expect(events[0]).toEqual({
      type: 'updateDevice',
      interfaceId: 'MyCCU-HmIP-RF',
      address: 'VCU001',
      hint: 1,
    });
  });

  it('replaceDevice(...) emits old/new addresses', () => {
    const { events, emit } = collect();
    dispatch(
      { methodName: 'replaceDevice', params: ['MyCCU-HmIP-RF', 'OLD', 'NEW'] },
      { emit, listDevices: () => [] },
    );
    expect(events[0]).toEqual({
      type: 'replaceDevice',
      interfaceId: 'MyCCU-HmIP-RF',
      oldAddress: 'OLD',
      newAddress: 'NEW',
    });
  });

  it('readdedDevice(...) emits addresses', () => {
    const { events, emit } = collect();
    dispatch(
      { methodName: 'readdedDevice', params: ['MyCCU-HmIP-RF', ['VCU001']] },
      { emit, listDevices: () => [] },
    );
    expect(events[0]).toEqual({
      type: 'readdedDevice',
      interfaceId: 'MyCCU-HmIP-RF',
      addresses: ['VCU001'],
    });
  });

  it('error(...) emits code and message', () => {
    const { events, emit } = collect();
    dispatch(
      { methodName: 'error', params: ['MyCCU-HmIP-RF', 7, 'boom'] },
      { emit, listDevices: () => [] },
    );
    expect(events[0]).toEqual({
      type: 'error',
      interfaceId: 'MyCCU-HmIP-RF',
      code: 7,
      message: 'boom',
    });
  });
});

describe('callback handlers — listDevices', () => {
  it('returns the injected provider list and does NOT emit', () => {
    const { events, emit } = collect();
    const devices = [{ ADDRESS: 'VCU001', TYPE: 'HmIP-FOO' }];
    const result = dispatch(
      { methodName: 'listDevices', params: ['MyCCU-HmIP-RF'] },
      { emit, listDevices: () => devices },
    );
    expect(result).toEqual(devices);
    expect(events).toHaveLength(0);
  });
});

describe('callback handlers — system.*', () => {
  it('system.listMethods returns the supported method names', () => {
    const { emit } = collect();
    const result = dispatch(
      { methodName: 'system.listMethods', params: [] },
      { emit, listDevices: () => [] },
    );
    expect(result).toEqual(SUPPORTED_METHODS);
  });

  it('system.methodHelp returns a string', () => {
    const { emit } = collect();
    const result = dispatch(
      { methodName: 'system.methodHelp', params: ['event'] },
      { emit, listDevices: () => [] },
    );
    expect(typeof result).toBe('string');
  });

  it('unknown method throws MethodNotFoundError', () => {
    const { emit } = collect();
    expect(() =>
      dispatch({ methodName: 'nope', params: [] }, { emit, listDevices: () => [] }),
    ).toThrow(MethodNotFoundError);
  });
});

describe('callback handlers — system.multicall', () => {
  it('wraps each successful result as [result] and emits in order', () => {
    const { events, emit } = collect();
    const result = dispatch(
      {
        methodName: 'system.multicall',
        params: [
          [
            { methodName: 'event', params: ['IF', 'VCU001:1', 'STATE', true] },
            { methodName: 'deleteDevices', params: ['IF', ['VCU009']] },
          ],
        ],
      },
      { emit, listDevices: () => [] },
    );
    expect(result).toEqual([[true], [true]]);
    expect(events.map((e) => e.type)).toEqual(['event', 'deleteDevices']);
  });

  it('not-found method inside multicall → fault -32601', () => {
    const { emit } = collect();
    const result = dispatch(
      {
        methodName: 'system.multicall',
        params: [[{ methodName: 'nope', params: [] }]],
      },
      { emit, listDevices: () => [] },
    ) as unknown[];
    expect(result[0]).toMatchObject({ faultCode: -32601 });
  });

  it('throwing handler inside multicall → fault -32603', () => {
    const { emit } = collect();
    const result = dispatch(
      {
        methodName: 'system.multicall',
        params: [[{ methodName: 'event', params: ['IF'] }]],
      },
      { emit, listDevices: () => [] },
    ) as unknown[];
    expect(result[0]).toMatchObject({ faultCode: -32603 });
  });

  it('non-array calls payload throws InvalidParamsError', () => {
    const { emit } = collect();
    expect(() =>
      dispatch(
        { methodName: 'system.multicall', params: ['not-an-array'] },
        { emit, listDevices: () => [] },
      ),
    ).toThrow();
  });

  it('non-struct entry → fault -32603', () => {
    const { emit } = collect();
    const result = dispatch(
      { methodName: 'system.multicall', params: [['not-a-struct']] },
      { emit, listDevices: () => [] },
    ) as Array<{ faultCode: number }>;
    expect(result[0]).toMatchObject({ faultCode: -32603 });
  });

  it('entry missing methodName → fault -32603', () => {
    const { emit } = collect();
    const result = dispatch(
      { methodName: 'system.multicall', params: [[{ params: [] }]] },
      { emit, listDevices: () => [] },
    ) as Array<{ faultCode: number }>;
    expect(result[0]).toMatchObject({ faultCode: -32603 });
  });

  it('recursive system.multicall entry → fault -32603', () => {
    const { emit } = collect();
    const result = dispatch(
      {
        methodName: 'system.multicall',
        params: [[{ methodName: 'system.multicall', params: [] }]],
      },
      { emit, listDevices: () => [] },
    ) as Array<{ faultCode: number }>;
    expect(result[0]).toMatchObject({ faultCode: -32603 });
  });

  it('entry with non-array params defaults to empty params', () => {
    const { events, emit } = collect();
    const result = dispatch(
      {
        methodName: 'system.multicall',
        params: [[{ methodName: 'system.listMethods' }]],
      },
      { emit, listDevices: () => [] },
    ) as unknown[];
    expect(Array.isArray(result[0])).toBe(true);
    expect(events).toHaveLength(0);
  });
});
