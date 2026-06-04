import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { XmlRpcClient } from '../../../../src/transport/xmlrpc/client.js';
import {
  AuthFailureError,
  ClientError,
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
  return `http://127.0.0.1:${port}/`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

const responseXml = (inner: string): string =>
  `<?xml version="1.0" encoding="iso-8859-1"?><methodResponse><params><param><value>${inner}</value></param></params></methodResponse>`;

const faultXml = (code: number, str: string): string =>
  `<?xml version="1.0"?><methodResponse><fault><value><struct>` +
  `<member><name>faultCode</name><value><i4>${code}</i4></value></member>` +
  `<member><name>faultString</name><value><string>${str}</string></value></member>` +
  `</struct></value></fault></methodResponse>`;

describe('XmlRpcClient.call', () => {
  it('POSTs with Content-Type text/xml and returns the parsed value', async () => {
    let seenContentType: string | undefined;
    let seenBody = '';
    const url = await startServer((req, res, body) => {
      seenContentType = req.headers['content-type'];
      seenBody = body.toString('latin1');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(responseXml('<i4>7</i4>'));
    });
    const client = new XmlRpcClient({ url, timeoutMs: 2000 });
    const result = await client.call('getValue', ['VCU001:1', 'STATE']);
    expect(result).toBe(7);
    expect(seenContentType).toContain('text/xml');
    expect(seenBody).toContain('<methodName>getValue</methodName>');
  });

  it('sends Basic auth when configured', async () => {
    let auth: string | undefined;
    const url = await startServer((req, res) => {
      auth = req.headers['authorization'];
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(responseXml('<boolean>1</boolean>'));
    });
    const client = new XmlRpcClient({
      url,
      auth: { username: 'admin', password: 'secret' },
      timeoutMs: 2000,
    });
    const result = await client.call('ping', ['caller']);
    expect(result).toBe(true);
    const expected = 'Basic ' + Buffer.from('admin:secret').toString('base64');
    expect(auth).toBe(expected);
  });

  it('fault "unauthorized" → AuthFailureError', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(faultXml(-1, 'Unauthorized'));
    });
    const client = new XmlRpcClient({ url, timeoutMs: 2000 });
    await expect(client.call('getValue', [])).rejects.toBeInstanceOf(AuthFailureError);
  });

  it('fault "internal" → InternalBackendError', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(faultXml(-1, 'internal error'));
    });
    const client = new XmlRpcClient({ url, timeoutMs: 2000 });
    await expect(client.call('getValue', [])).rejects.toBeInstanceOf(InternalBackendError);
  });

  it('empty body (HTTP 200) → ClientError', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('');
    });
    const client = new XmlRpcClient({ url, timeoutMs: 2000 });
    await expect(client.call('listDevices', [])).rejects.toBeInstanceOf(ClientError);
  });

  it('connection refused → NoConnectionError', async () => {
    // Bind a server to obtain a real port, then close it so the port refuses.
    const url = await startServer(() => {});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const client = new XmlRpcClient({ url, timeoutMs: 2000 });
    await expect(client.call('listDevices', [])).rejects.toBeInstanceOf(NoConnectionError);
  });

  it('timeout → NoConnectionError', async () => {
    const url = await startServer(() => {
      // Never respond.
    });
    const client = new XmlRpcClient({ url, timeoutMs: 50 });
    await expect(client.call('listDevices', [])).rejects.toBeInstanceOf(NoConnectionError);
  });

  it('correctly decodes a response with latin1 accents', async () => {
    const url = await startServer((req, res) => {
      const xml = responseXml('<string>café</string>');
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(Buffer.from(xml, 'latin1'));
    });
    const client = new XmlRpcClient({ url, timeoutMs: 2000 });
    const result = await client.call('getValue', []);
    expect(result).toBe('café');
  });

  it('response that is a methodCall → ClientError', async () => {
    const url = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<methodCall><methodName>oops</methodName></methodCall>');
    });
    const client = new XmlRpcClient({ url, timeoutMs: 2000 });
    await expect(client.call('getValue', [])).rejects.toBeInstanceOf(ClientError);
  });

  it('close() with a TLS dispatcher is idempotent and does not throw', async () => {
    const tlsClient = new XmlRpcClient({
      url: 'https://127.0.0.1:1/',
      tls: { rejectUnauthorized: false },
      timeoutMs: 1000,
    });
    await expect(tlsClient.close()).resolves.toBeUndefined();
    // Client without a dispatcher: close is still safe.
    const plain = new XmlRpcClient({ url: 'http://127.0.0.1:1/', timeoutMs: 1000 });
    await expect(plain.close()).resolves.toBeUndefined();
  });
});
