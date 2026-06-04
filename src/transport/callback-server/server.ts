/**
 * Local XML-RPC callback server. The CCU POSTs its notifications (`event`,
 * `newDevices`, `system.multicall`, …) here; we parse the methodCall, dispatch
 * it to {@link handlers}, and reply with an XML-RPC methodResponse or fault.
 *
 * Protocol specifics handled:
 * - Inbound bodies are UTF-8 (note: this differs from the ISO-8859-1 used for
 *   OUTBOUND XML-RPC calls to the CCU).
 * - A handler returning `null`/`undefined` is serialized as boolean `true`
 *   (Homematic expects an ack).
 * - Method-not-found → fault -32601; handler exception → fault -32603. XML-RPC
 *   faults are returned with HTTP 200.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseXmlRpc } from '../xmlrpc/parse.js';
import { serializeFault, serializeMethodResponse } from '../xmlrpc/serialize.js';
import type { XmlRpcValue } from '../xmlrpc/types.js';
import type { RawCallbackEvent } from './events.js';
import {
  dispatch,
  FAULT_INTERNAL_ERROR,
  FAULT_METHOD_NOT_FOUND,
  MethodNotFoundError,
  type DispatchContext,
} from './handlers.js';

const CONTENT_TYPE = 'text/xml; charset=utf-8';

/** Construction options for {@link CallbackServer}. */
export interface CallbackServerOptions {
  /** Host/interface to bind. */
  readonly host: string;
  /** Port to bind; `0` requests an ephemeral port (read it back via {@link CallbackServer.port}). */
  readonly port: number;
  /** Invoked for every normalized callback event the CCU pushes. */
  readonly onEvent: (event: RawCallbackEvent) => void;
  /** Supplies the device list for `listDevices(interfaceId)`. Defaults to `() => []`. */
  readonly listDevicesProvider?: (interfaceId: string) => readonly XmlRpcValue[];
}

/** An XML-RPC callback HTTP server backed by `node:http`. */
export class CallbackServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly onEvent: (event: RawCallbackEvent) => void;
  private readonly listDevicesProvider: (interfaceId: string) => readonly XmlRpcValue[];
  private readonly httpServer: Server;
  private boundPort = 0;

  public constructor(options: CallbackServerOptions) {
    this.host = options.host;
    this.requestedPort = options.port;
    this.onEvent = options.onEvent;
    this.listDevicesProvider = options.listDevicesProvider ?? ((): readonly XmlRpcValue[] => []);
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  /** The actual bound port (meaningful only after {@link start} resolves). */
  public get port(): number {
    return this.boundPort;
  }

  /** Start listening. Resolves once the socket is bound. */
  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.httpServer.removeListener('error', onError);
        reject(err);
      };
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.requestedPort, this.host, () => {
        this.httpServer.removeListener('error', onError);
        const address = this.httpServer.address() as AddressInfo | null;
        this.boundPort = address?.port ?? this.requestedPort;
        resolve();
      });
    });
  }

  /** Stop listening and release the socket. Resolves once closed. */
  public async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const payload = this.process(body);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPE, 'Content-Length': payload.length });
      res.end(payload);
    });
    req.on('error', () => {
      const payload = serializeFault(FAULT_INTERNAL_ERROR, 'request stream error');
      res.writeHead(200, { 'Content-Type': CONTENT_TYPE, 'Content-Length': payload.length });
      res.end(payload);
    });
  }

  /** Parse, dispatch and serialize a single request body into a response buffer. */
  private process(body: Buffer): Buffer {
    let methodName = '';
    let params: XmlRpcValue[] = [];
    try {
      // Inbound callback bodies are UTF-8.
      const parsed = parseXmlRpc(body.toString('utf-8'));
      if (parsed.kind !== 'call') {
        return serializeFault(FAULT_INTERNAL_ERROR, 'expected an XML-RPC methodCall');
      }
      methodName = parsed.call.methodName;
      params = parsed.call.params;
    } catch (err) {
      return serializeFault(FAULT_INTERNAL_ERROR, errorMessage(err));
    }

    const ctx: DispatchContext = {
      emit: this.onEvent,
      listDevices: this.listDevicesProvider,
    };

    try {
      const result = dispatch({ methodName, params }, ctx);
      // A handler that conceptually returns void acks with boolean true.
      const value: XmlRpcValue = result ?? true;
      return serializeMethodResponse(value);
    } catch (err) {
      if (err instanceof MethodNotFoundError) {
        return serializeFault(FAULT_METHOD_NOT_FOUND, errorMessage(err));
      }
      return serializeFault(FAULT_INTERNAL_ERROR, errorMessage(err));
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
