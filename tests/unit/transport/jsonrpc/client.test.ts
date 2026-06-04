import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { JsonRpcClient } from '../../../../src/transport/jsonrpc/client.js';
import {
  AuthFailureError,
  InternalBackendError,
  NoConnectionError,
} from '../../../../src/support/errors.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

let server: Server | undefined;

async function startServer(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

interface Envelope {
  method: string;
  params: Record<string, string>;
  jsonrpc: string;
  id: number;
}

describe('JsonRpcClient.post', () => {
  it('POSTs a 1.1 envelope with id 0 to JSON_RPC_PATH and resolves the result', async () => {
    let seenPath: string | undefined;
    let seenContentType: string | undefined;
    let seenEnvelope: Envelope | undefined;
    const url = await startServer((req, res, body) => {
      seenPath = req.url;
      seenContentType = req.headers['content-type'];
      seenEnvelope = JSON.parse(body.toString('utf-8')) as Envelope;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { ok: 1 }, error: null, id: 0 }));
    });
    const client = new JsonRpcClient({ url, timeoutMs: 2000 });
    const result = await client.post('Device.listAllDetail');
    expect(result).toEqual({ ok: 1 });
    expect(seenPath).toBe('/api/homematic.cgi');
    expect(seenContentType).toContain('application/json');
    expect(seenEnvelope?.jsonrpc).toBe('1.1');
    expect(seenEnvelope?.id).toBe(0);
    expect(seenEnvelope?.method).toBe('Device.listAllDetail');
  });

  it('coerces all param values to strings', async () => {
    let seenEnvelope: Envelope | undefined;
    const url = await startServer((req, res, body) => {
      seenEnvelope = JSON.parse(body.toString('utf-8')) as Envelope;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: true, error: null, id: 0 }));
    });
    const client = new JsonRpcClient({ url, timeoutMs: 2000 });
    await client.post('Interface.setInstallModeHMIP', {
      on: true,
      time: 60,
      name: 'x',
    });
    expect(seenEnvelope?.params).toEqual({ on: 'true', time: '60', name: 'x' });
  });

  it('injects _session_id_ when a sessionId is passed', async () => {
    let seenEnvelope: Envelope | undefined;
    const url = await startServer((req, res, body) => {
      seenEnvelope = JSON.parse(body.toString('utf-8')) as Envelope;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: true, error: null, id: 0 }));
    });
    const client = new JsonRpcClient({ url, timeoutMs: 2000 });
    await client.post('SysVar.getAll', undefined, { sessionId: 'abc123' });
    expect(seenEnvelope?.params['_session_id_']).toBe('abc123');
  });

  it('JSON-encodes nested object/array param values', async () => {
    let seenEnvelope: Envelope | undefined;
    const url = await startServer((req, res, body) => {
      seenEnvelope = JSON.parse(body.toString('utf-8')) as Envelope;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: true, error: null, id: 0 }));
    });
    const client = new JsonRpcClient({ url, timeoutMs: 2000 });
    await client.post('Whatever', { values: [1, 2], obj: { a: 1 } });
    expect(seenEnvelope?.params['values']).toBe('[1,2]');
    expect(seenEnvelope?.params['obj']).toBe('{"a":1}');
  });

  it('maps error.code -32001 / "access denied" to AuthFailureError', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          result: null,
          error: { code: -32001, message: 'access denied: bad credentials' },
          id: 0,
        }),
      );
    });
    const client = new JsonRpcClient({ url, timeoutMs: 2000 });
    await expect(client.post('Session.renew')).rejects.toBeInstanceOf(AuthFailureError);
  });

  it('maps error.code -32603 to InternalBackendError', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: null, error: { code: -32603 }, id: 0 }));
    });
    const client = new JsonRpcClient({ url, timeoutMs: 2000 });
    await expect(client.post('Device.listAllDetail')).rejects.toBeInstanceOf(InternalBackendError);
  });

  it('connection refused → NoConnectionError', async () => {
    const url = await startServer(() => {});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const client = new JsonRpcClient({ url, timeoutMs: 2000 });
    await expect(client.post('Device.listAllDetail')).rejects.toBeInstanceOf(NoConnectionError);
  });

  it('timeout → NoConnectionError', async () => {
    const url = await startServer(() => {
      // never respond
    });
    const client = new JsonRpcClient({ url, timeoutMs: 50 });
    await expect(client.post('Device.listAllDetail')).rejects.toBeInstanceOf(NoConnectionError);
  });

  it('never exceeds maxConcurrent in-flight requests', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<() => void> = [];
    const url = await startServer((_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold the response open until released.
      pending.push(() => {
        inFlight -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: true, error: null, id: 0 }));
      });
      // Release this one shortly so the queue drains.
      setTimeout(() => {
        const next = pending.shift();
        if (next) next();
      }, 20);
    });
    const client = new JsonRpcClient({ url, timeoutMs: 5000, maxConcurrent: 3 });
    const calls = Array.from({ length: 12 }, () => client.post('Device.listAllDetail'));
    await Promise.all(calls);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('uses a TLS dispatcher and close() is safe', async () => {
    const tlsClient = new JsonRpcClient({
      url: 'https://127.0.0.1:1',
      tls: { rejectUnauthorized: false },
      timeoutMs: 1000,
    });
    await expect(tlsClient.close()).resolves.toBeUndefined();
    const plain = new JsonRpcClient({ url: 'http://127.0.0.1:1', timeoutMs: 1000 });
    await expect(plain.close()).resolves.toBeUndefined();
  });
});
