import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'undici';
import { CallbackServer } from '../../../../src/transport/callback-server/server.js';
import type { RawCallbackEvent } from '../../../../src/transport/callback-server/events.js';
import { parseXmlRpc } from '../../../../src/transport/xmlrpc/parse.js';
import { serializeMethodCall } from '../../../../src/transport/xmlrpc/serialize.js';
import type { XmlRpcValue } from '../../../../src/transport/xmlrpc/types.js';

let server: CallbackServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

/** Build a methodCall body as UTF-8 (callback bodies are UTF-8 per protocol). */
function utf8Call(methodName: string, params: XmlRpcValue[]): Buffer {
  // serializeMethodCall emits latin1; re-encode the same XML string as UTF-8.
  const latin1 = serializeMethodCall(methodName, params).toString('latin1');
  const utf8 = latin1.replace('iso-8859-1', 'utf-8');
  return Buffer.from(utf8, 'utf-8');
}

async function post(port: number, body: Buffer): Promise<{ status: number; value: unknown }> {
  const res = await request(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body,
  });
  const buf = Buffer.from(await res.body.arrayBuffer());
  const parsed = parseXmlRpc(buf);
  return { status: res.statusCode, value: parsed };
}

describe('CallbackServer — event', () => {
  it('normalizes an event(...) call and responds with boolean true', async () => {
    const events: RawCallbackEvent[] = [];
    server = new CallbackServer({
      host: '127.0.0.1',
      port: 0,
      onEvent: (e): void => {
        events.push(e);
      },
    });
    await server.start();
    const { status, value } = await post(
      server.port,
      utf8Call('event', ['MyCCU-HmIP-RF', 'VCU001:1', 'LEVEL', 0.5]),
    );
    expect(status).toBe(200);
    expect(value).toEqual({ kind: 'response', value: true });
    expect(events).toEqual([
      {
        type: 'event',
        interfaceId: 'MyCCU-HmIP-RF',
        channelAddress: 'VCU001:1',
        parameter: 'LEVEL',
        value: 0.5,
      },
    ]);
  });

  it('newDevices with a list → onEvent gets descriptions array', async () => {
    const events: RawCallbackEvent[] = [];
    server = new CallbackServer({
      host: '127.0.0.1',
      port: 0,
      onEvent: (e): void => {
        events.push(e);
      },
    });
    await server.start();
    const descriptions: XmlRpcValue = [{ ADDRESS: 'VCU001', TYPE: 'HmIP-FOO' }];
    await post(server.port, utf8Call('newDevices', ['MyCCU-HmIP-RF', descriptions]));
    expect(events[0]).toMatchObject({
      type: 'newDevices',
      interfaceId: 'MyCCU-HmIP-RF',
      descriptions: [{ ADDRESS: 'VCU001', TYPE: 'HmIP-FOO' }],
    });
  });
});

describe('CallbackServer — listDevices', () => {
  it('returns the injected provider array', async () => {
    server = new CallbackServer({
      host: '127.0.0.1',
      port: 0,
      onEvent: (): void => {},
      listDevicesProvider: (): XmlRpcValue[] => [{ ADDRESS: 'VCU001', TYPE: 'HmIP-FOO' }],
    });
    await server.start();
    const { value } = await post(server.port, utf8Call('listDevices', ['MyCCU-HmIP-RF']));
    expect(value).toEqual({
      kind: 'response',
      value: [{ ADDRESS: 'VCU001', TYPE: 'HmIP-FOO' }],
    });
  });
});

describe('CallbackServer — system.multicall', () => {
  it('returns an array of [true]/[true] and emits both events in order', async () => {
    const events: RawCallbackEvent[] = [];
    server = new CallbackServer({
      host: '127.0.0.1',
      port: 0,
      onEvent: (e): void => {
        events.push(e);
      },
    });
    await server.start();
    const calls: XmlRpcValue = [
      { methodName: 'event', params: ['IF', 'VCU001:1', 'STATE', true] },
      { methodName: 'deleteDevices', params: ['IF', ['VCU009']] },
    ];
    const { value } = await post(server.port, utf8Call('system.multicall', [calls]));
    expect(value).toEqual({ kind: 'response', value: [[true], [true]] });
    expect(events.map((e) => e.type)).toEqual(['event', 'deleteDevices']);
  });
});

describe('CallbackServer — faults', () => {
  it('unknown method → fault -32601 (HTTP 200)', async () => {
    server = new CallbackServer({ host: '127.0.0.1', port: 0, onEvent: (): void => {} });
    await server.start();
    const { status, value } = await post(server.port, utf8Call('nope', []));
    expect(status).toBe(200);
    expect(value).toMatchObject({ kind: 'fault', fault: { faultCode: -32601 } });
  });

  it('handler exception (malformed event params) → fault -32603 (HTTP 200)', async () => {
    server = new CallbackServer({ host: '127.0.0.1', port: 0, onEvent: (): void => {} });
    await server.start();
    const { status, value } = await post(server.port, utf8Call('event', ['IF', 'VCU001:1']));
    expect(status).toBe(200);
    expect(value).toMatchObject({ kind: 'fault', fault: { faultCode: -32603 } });
  });
});

describe('CallbackServer — ack semantics', () => {
  it('a void-returning handler serializes as boolean true', async () => {
    // updateDevice conceptually returns nothing meaningful; we still ack true.
    server = new CallbackServer({ host: '127.0.0.1', port: 0, onEvent: (): void => {} });
    await server.start();
    const { value } = await post(server.port, utf8Call('updateDevice', ['IF', 'VCU001', 0]));
    expect(value).toEqual({ kind: 'response', value: true });
  });
});

describe('CallbackServer — bad input', () => {
  it('a methodResponse body (not a methodCall) → fault -32603', async () => {
    server = new CallbackServer({ host: '127.0.0.1', port: 0, onEvent: (): void => {} });
    await server.start();
    const body = Buffer.from(
      '<?xml version="1.0" encoding="utf-8"?><methodResponse><params><param>' +
        '<value><boolean>1</boolean></value></param></params></methodResponse>',
      'utf-8',
    );
    const { status, value } = await post(server.port, body);
    expect(status).toBe(200);
    expect(value).toMatchObject({ kind: 'fault', fault: { faultCode: -32603 } });
  });

  it('an empty body → fault -32603', async () => {
    server = new CallbackServer({ host: '127.0.0.1', port: 0, onEvent: (): void => {} });
    await server.start();
    const { status, value } = await post(server.port, Buffer.alloc(0));
    expect(status).toBe(200);
    expect(value).toMatchObject({ kind: 'fault', fault: { faultCode: -32603 } });
  });
});

describe('CallbackServer — lifecycle', () => {
  it('binds an ephemeral port when port is 0 and exposes it', async () => {
    server = new CallbackServer({ host: '127.0.0.1', port: 0, onEvent: (): void => {} });
    await server.start();
    expect(server.port).toBeGreaterThan(0);
  });
});
