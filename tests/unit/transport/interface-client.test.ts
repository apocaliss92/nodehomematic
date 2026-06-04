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
  it('expose interfaceId come "{centralName}-{interface}"', () => {
    const subject = makeSubject();
    expect(subject.interfaceId).toBe('MyCCU-HmIP-RF');
  });

  it('initProxy chiama init con [callbackUrl, interfaceId] e va in CONNECTED', async () => {
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.initProxy();
    expect(calls).toContainEqual({
      method: 'init',
      params: ['http://callback:9000', 'MyCCU-HmIP-RF'],
    });
    expect(subject.state).toBe(ClientState.CONNECTED);
  });

  it('deinitProxy chiama init con un SINGOLO argomento [callbackUrl]', async () => {
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

  it('setValue ritenta su fault -8 e poi risolve', async () => {
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

  it('setValue NON ritenta su AuthFailureError', async () => {
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

  it('chiamata non-bypass su breaker OPEN lancia CircuitBreakerOpenError e registra una rejection', async () => {
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

  it('chiamata bypass (ping) passa anche con breaker OPEN', async () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 5; i += 1) breaker.recordFailure();
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client, circuitBreaker: breaker });
    await expect(subject.ping()).resolves.toBe(true);
    expect(calls).toContainEqual({ method: 'ping', params: ['MyCCU-HmIP-RF'] });
  });

  it('listDevices ritorna le device description dell array', async () => {
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

  it('getParamsetDescription ritorna la struct (coalesced)', async () => {
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

  it('getParamset ritorna la struct', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getParamset') return Promise.resolve({ STATE: true });
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getParamset('VCU001:1', 'VALUES')).resolves.toEqual({ STATE: true });
  });

  it('getValue ritorna il valore grezzo', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getValue') return Promise.resolve(21.5);
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getValue('VCU001:1', 'TEMP')).resolves.toBe(21.5);
  });

  it('putParamset chiama putParamset con i valori e accetta rxMode', async () => {
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.putParamset('VCU001:1', 'VALUES', { STATE: true }, 'BURST');
    expect(calls).toContainEqual({
      method: 'putParamset',
      params: ['VCU001:1', 'VALUES', { STATE: true }, 'BURST'],
    });
  });

  it('setValue con rxMode passa il quarto argomento', async () => {
    const { client, calls } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.setValue('VCU001:1', 'STATE', true, 'WAKEUP');
    expect(calls).toContainEqual({
      method: 'setValue',
      params: ['VCU001:1', 'STATE', true, 'WAKEUP'],
    });
  });

  it('getInstallMode ritorna il numero', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getInstallMode') return Promise.resolve(60);
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getInstallMode()).resolves.toBe(60);
  });

  it('getVersion e listMethods (bypass) ritornano stringa e array', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getVersion') return Promise.resolve('3.2.1');
      if (method === 'system.listMethods') return Promise.resolve(['init', 'ping']);
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getVersion()).resolves.toBe('3.2.1');
    await expect(subject.listMethods()).resolves.toEqual(['init', 'ping']);
  });

  it('initProxy fallito porta la state machine in FAILED e rilancia', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'init') return Promise.reject(new Error('boom'));
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.initProxy()).rejects.toThrow('boom');
    expect(subject.state).toBe(ClientState.FAILED);
  });

  it('onStateChange notifica i subscriber sulle transizioni', async () => {
    const { client } = makeFakeClient();
    const subject = makeSubject({ client });
    const states: ClientState[] = [];
    const unsubscribe = subject.onStateChange((e) => states.push(e.to));
    await subject.initProxy();
    unsubscribe();
    expect(states).toContain(ClientState.CONNECTED);
  });

  it('deinitProxy porta in DISCONNECTED dopo init', async () => {
    const { client } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.initProxy();
    await subject.deinitProxy();
    expect(subject.state).toBe(ClientState.DISCONNECTED);
  });

  it('usa la factory di default (XmlRpcClient) quando makeClient non e fornito', () => {
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

  it('getInstallMode ritorna 0 se la CCU risponde con un non-numero', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getInstallMode') return Promise.resolve('nope');
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getInstallMode()).resolves.toBe(0);
  });

  it('getVersion rifiuta una risposta non scalare', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getVersion') return Promise.resolve({ weird: 1 });
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getVersion()).rejects.toThrow();
  });

  it('listMethods ritorna [] se la risposta non e un array', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'system.listMethods') return Promise.resolve('nope');
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.listMethods()).resolves.toEqual([]);
  });

  it('listDevices rifiuta una risposta non-array', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'listDevices') return Promise.resolve({ not: 'array' });
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.listDevices()).rejects.toThrow();
  });

  it('getParamset rifiuta una risposta non-struct', async () => {
    const { client } = makeFakeClient((method) => {
      if (method === 'getParamset') return Promise.resolve([1, 2, 3]);
      return Promise.resolve(true);
    });
    const subject = makeSubject({ client });
    await expect(subject.getParamset('VCU001:1', 'VALUES')).rejects.toThrow();
  });

  it('initProxy due volte consecutive ripercorre transizioni valide', async () => {
    const { client } = makeFakeClient();
    const subject = makeSubject({ client });
    await subject.initProxy();
    await subject.deinitProxy();
    await subject.initProxy();
    expect(subject.state).toBe(ClientState.CONNECTED);
  });

  it('getDeviceDescription concorrente sulla stessa address chiama il client una volta', async () => {
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
