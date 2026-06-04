import { describe, it, expect } from 'vitest';
import { InterfaceClient } from '../../../src/transport/interface-client.js';
import type { XmlRpcClientLike } from '../../../src/transport/interface-client.js';
import { Interface } from '../../../src/support/constants.js';
import { CircuitBreaker } from '../../../src/transport/resilience/circuit-breaker.js';
import { AuthFailureError, CircuitBreakerOpenError } from '../../../src/support/errors.js';
import { ClientState } from '../../../src/transport/resilience/state-machine.js';
import type { XmlRpcValue } from '../../../src/transport/xmlrpc/types.js';

interface RecordedCall {
  readonly method: string;
  readonly params: readonly XmlRpcValue[];
}

/** Build a fake XmlRpcClient that records calls and returns canned values. */
function makeFakeClient(
  impl?: (method: string, params: readonly XmlRpcValue[]) => Promise<XmlRpcValue>,
): { client: XmlRpcClientLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: XmlRpcClientLike = {
    call: (method, params): Promise<XmlRpcValue> => {
      calls.push({ method, params });
      if (impl) return impl(method, params);
      return Promise.resolve(true);
    },
  };
  return { client, calls };
}

/** Construct an InterfaceClient wired to a fake client and recording sleep. */
function makeSubject(opts?: {
  client?: XmlRpcClientLike;
  circuitBreaker?: CircuitBreaker;
}): InterfaceClient {
  const { client } = opts?.client ? { client: opts.client } : makeFakeClient();
  return new InterfaceClient({
    centralName: 'MyCCU',
    interface: Interface.HMIP_RF,
    host: 'ccu.local',
    callbackUrlProvider: () => 'http://callback:9000',
    circuitBreaker: opts?.circuitBreaker,
    makeClient: () => client,
    retryOptions: { sleep: () => Promise.resolve(), baseDelayMs: 0, jitter: 0 },
  });
}

describe('InterfaceClient', () => {
  it('exposes interfaceId as "{centralName}-{interface}"', () => {
    const subject = makeSubject();
    expect(subject.interfaceId).toBe('MyCCU-HmIP-RF');
  });

  it('initProxy calls init with [callbackUrl, interfaceId] and goes to CONNECTED', async () => {
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.initProxy();
    expect(calls).toContainEqual({
      method: 'init',
      params: ['http://callback:9000', 'MyCCU-HmIP-RF'],
    });
    expect(subject.state).toBe(ClientState.CONNECTED);
  });

  it('deinitProxy calls init with a SINGLE argument [callbackUrl]', async () => {
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.initProxy();
    calls.length = 0;
    await subject.deinitProxy();
    expect(calls).toContainEqual({
      method: 'init',
      params: ['http://callback:9000'],
    });
  });

  it('setValue retries on fault -8 and then resolves', async () => {
    let attempts = 0;
    const { client } = makeFakeClient((method) => {
      if (method === 'setValue') {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('duty cycle') as Error & { faultCode: number };
          err.faultCode = -8;
          return Promise.reject(err);
        }
      }
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.setValue('VCU001:1', 'STATE', true)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('setValue does NOT retry on AuthFailureError', async () => {
    let attempts = 0;
    const { client } = makeFakeClient((method) => {
      if (method === 'setValue') {
        attempts += 1;
        return Promise.reject(new AuthFailureError('denied'));
      }
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.setValue('VCU001:1', 'STATE', true)).rejects.toBeInstanceOf(
      AuthFailureError,
    );
    expect(attempts).toBe(1);
  });

  it('a non-bypass call on an OPEN breaker throws CircuitBreakerOpenError and records a rejection', async () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 5; i += 1) breaker.recordFailure();
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client, circuitBreaker: breaker });
    await expect(subject.getValue('VCU001:1', 'STATE')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
    expect(breaker.rejections).toBe(1);
    expect(calls.find((c) => c.method === 'getValue')).toBeUndefined();
  });

  it('a bypass call (ping) passes even with an OPEN breaker', async () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 5; i += 1) breaker.recordFailure();
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client, circuitBreaker: breaker });
    await expect(subject.ping()).resolves.toBe(true);
    expect(calls).toContainEqual({ method: 'ping', params: ['MyCCU-HmIP-RF'] });
  });

  it('listDevices returns the device descriptions from the array', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'listDevices') {
        return Promise.resolve([{ ADDRESS: 'VCU001:1', TYPE: 'X' }]);
      }
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    const devices = await subject.listDevices();
    expect(devices).toEqual([{ ADDRESS: 'VCU001:1', TYPE: 'X' }]);
  });

  it('getParamsetDescription returns the struct (coalesced)', async () => {
    const { client, calls } = makeFakeClient((method) => {
      if (method === 'getParamsetDescription') {
        return Promise.resolve({ STATE: { TYPE: 'BOOL' } });
      }
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    const [a, b] = await Promise.all([
      subject.getParamsetDescription('VCU001:1', 'VALUES'),
      subject.getParamsetDescription('VCU001:1', 'VALUES'),
    ]);
    expect(a).toEqual({ STATE: { TYPE: 'BOOL' } });
    expect(b).toEqual(a);
    expect(calls.filter((c) => c.method === 'getParamsetDescription')).toHaveLength(1);
  });

  it('getParamset returns the struct', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getParamset') return Promise.resolve({ STATE: true });
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getParamset('VCU001:1', 'VALUES')).resolves.toEqual({ STATE: true });
  });

  it('getValue returns the raw value', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getValue') return Promise.resolve(21.5);
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getValue('VCU001:1', 'TEMP')).resolves.toBe(21.5);
  });

  it('putParamset calls putParamset with the values and accepts rxMode', async () => {
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.putParamset('VCU001:1', 'VALUES', { STATE: true }, 'BURST');
    expect(calls).toContainEqual({
      method: 'putParamset',
      params: ['VCU001:1', 'VALUES', { STATE: true }, 'BURST'],
    });
  });

  it('setValue with rxMode passes the fourth argument', async () => {
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.setValue('VCU001:1', 'STATE', true, 'WAKEUP');
    expect(calls).toContainEqual({
      method: 'setValue',
      params: ['VCU001:1', 'STATE', true, 'WAKEUP'],
    });
  });

  it('getInstallMode returns the number', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getInstallMode') return Promise.resolve(60);
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getInstallMode()).resolves.toBe(60);
  });

  it('getVersion and listMethods (bypass) return a string and an array', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getVersion') return Promise.resolve('3.2.1');
      if (method === 'system.listMethods') return Promise.resolve(['init', 'ping']);
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getVersion()).resolves.toBe('3.2.1');
    await expect(subject.listMethods()).resolves.toEqual(['init', 'ping']);
  });

  it('a failed initProxy moves the state machine to FAILED and rethrows', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'init') return Promise.reject(new Error('boom'));
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.initProxy()).rejects.toThrow('boom');
    expect(subject.state).toBe(ClientState.FAILED);
  });

  it('onStateChange notifies subscribers on transitions', async () => {
    const { client } = makeFakeClient();
    const subject = makeSubject({ client });
    const states: ClientState[] = [];
    const unsubscribe = subject.onStateChange((e) => states.push(e.to));
    await subject.initProxy();
    unsubscribe();
    expect(states).toContain(ClientState.CONNECTED);
  });

  it('deinitProxy moves to DISCONNECTED after init', async () => {
    const { client } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.initProxy();
    await subject.deinitProxy();
    expect(subject.state).toBe(ClientState.DISCONNECTED);
  });

  it('uses the default factory (XmlRpcClient) when makeClient is not provided', () => {
    const subject = new InterfaceClient({
      centralName: 'MyCCU',
      interface: Interface.HMIP_RF,
      host: 'ccu.local',
      tls: true,
      auth: { username: 'u', password: 'p' },
      callbackUrlProvider: (): string => 'http://callback:9000',
    });
    expect(subject.interfaceId).toBe('MyCCU-HmIP-RF');
    expect(subject.state).toBe(ClientState.CREATED);
  });

  it('getInstallMode returns 0 if the CCU responds with a non-number', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getInstallMode') return Promise.resolve('nope');
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getInstallMode()).resolves.toBe(0);
  });

  it('getVersion rejects a non-scalar response', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getVersion') return Promise.resolve({ weird: 1 });
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getVersion()).rejects.toThrow();
  });

  it('listMethods returns [] if the response is not an array', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'system.listMethods') return Promise.resolve('nope');
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.listMethods()).resolves.toEqual([]);
  });

  it('listDevices rejects a non-array response', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'listDevices') return Promise.resolve({ not: 'array' });
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.listDevices()).rejects.toThrow();
  });

  it('getParamset rejects a non-struct response', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getParamset') return Promise.resolve([1, 2, 3]);
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getParamset('VCU001:1', 'VALUES')).rejects.toThrow();
  });

  it('initProxy twice in a row re-traverses valid transitions', async () => {
    const { client } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.initProxy();
    await subject.deinitProxy();
    await subject.initProxy();
    expect(subject.state).toBe(ClientState.CONNECTED);
  });

  it('builds the XML-RPC URL with the path (/groups) when provided', () => {
    let capturedUrl: string | undefined;
    const subject = new InterfaceClient({
      centralName: 'MyCCU',
      interface: Interface.VIRTUAL_DEVICES,
      host: 'ccu.local',
      path: '/groups',
      callbackUrlProvider: (): string => 'http://callback:9000',
      makeClient: (url): XmlRpcClientLike => {
        capturedUrl = url;
        return { call: (): Promise<XmlRpcValue> => Promise.resolve(true) };
      },
    });
    expect(subject.interfaceId).toBe('MyCCU-VirtualDevices');
    expect(capturedUrl).toBe('http://ccu.local:9292/groups');
  });

  it('without a path the XML-RPC URL ends with /', () => {
    let capturedUrl: string | undefined;
    new InterfaceClient({
      centralName: 'MyCCU',
      interface: Interface.HMIP_RF,
      host: 'ccu.local',
      callbackUrlProvider: (): string => 'http://callback:9000',
      makeClient: (url): XmlRpcClientLike => {
        capturedUrl = url;
        return { call: (): Promise<XmlRpcValue> => Promise.resolve(true) };
      },
    });
    expect(capturedUrl).toBe('http://ccu.local:2010/');
  });

  it('concurrent getDeviceDescription on the same address calls the client once', async () => {
    let calls = 0;
    let resolveFn: ((v: XmlRpcValue) => void) | undefined;
    const { client } = makeFakeClient((method) => {
      if (method === 'getDeviceDescription') {
        calls += 1;
        return new Promise<XmlRpcValue>((resolve) => {
          resolveFn = resolve;
        });
      }
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    const p1 = subject.getDeviceDescription('VCU001:1');
    const p2 = subject.getDeviceDescription('VCU001:1');
    resolveFn?.({ ADDRESS: 'VCU001:1', TYPE: 'X' });
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(d1).toEqual(d2);
  });
});
