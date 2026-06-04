/**
 * XML-RPC HTTP client for talking to a CCU interface. Serializes positional
 * method calls (ISO-8859-1), POSTs them with `Content-Type: text/xml`, parses
 * the response, and maps faults / transport failures to typed errors.
 */
import { Agent, fetch, type RequestInit } from 'undici';
import { ClientError, mapTransportError, mapXmlRpcFault } from '../../support/errors.js';
import { serializeMethodCall } from './serialize.js';
import { parseXmlRpc } from './parse.js';
import type { XmlRpcValue } from './types.js';

/** HTTP Basic auth credentials. */
export interface BasicAuth {
  readonly username: string;
  readonly password: string;
}

/** TLS options for HTTPS endpoints (e.g. CCU self-signed certificates). */
export interface TlsOptions {
  /** When false, accept self-signed / untrusted certificates. Defaults to true. */
  readonly rejectUnauthorized?: boolean;
}

/** Configuration for {@link XmlRpcClient}. */
export interface XmlRpcClientOptions {
  /** Full endpoint URL, e.g. `http://ccu:2010/`. */
  readonly url: string;
  /** Optional HTTP Basic auth. */
  readonly auth?: BasicAuth;
  /** Optional TLS settings for HTTPS endpoints. */
  readonly tls?: TlsOptions;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
}

function basicAuthHeader(auth: BasicAuth): string {
  const token = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Thin XML-RPC client. One instance targets a single endpoint URL. Stateless
 * apart from its config and an optional reusable TLS dispatcher.
 */
export class XmlRpcClient {
  private readonly options: XmlRpcClientOptions;
  private readonly dispatcher: Agent | undefined;

  public constructor(options: XmlRpcClientOptions) {
    this.options = options;
    // A custom dispatcher is only needed to relax/control TLS verification.
    if (options.tls?.rejectUnauthorized === false) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    } else {
      this.dispatcher = undefined;
    }
  }

  /**
   * Invoke an XML-RPC method with positional params and return the parsed
   * result. Throws a typed error on fault, empty body, or transport failure.
   */
  public async call(method: string, params: readonly XmlRpcValue[]): Promise<XmlRpcValue> {
    const body = serializeMethodCall(method, params);

    const headers: Record<string, string> = {
      'Content-Type': 'text/xml; charset=iso-8859-1',
      Accept: 'text/xml',
    };
    if (this.options.auth) {
      headers['Authorization'] = basicAuthHeader(this.options.auth);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let raw: Buffer;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      };
      if (this.dispatcher) init.dispatcher = this.dispatcher;

      const response = await fetch(this.options.url, init);
      const arrayBuffer = await response.arrayBuffer();
      raw = Buffer.from(arrayBuffer);
    } catch (err) {
      // Network/connection/abort failures become NoConnectionError (via mapper).
      throw mapTransportError(err);
    } finally {
      clearTimeout(timer);
    }

    if (raw.length === 0) {
      throw new ClientError('XML-RPC response had an empty body');
    }

    // The empty-body case is already handled by the `raw.length === 0` guard
    // above, so the parser can no longer throw EmptyBodyError here.
    const parsed = parseXmlRpc(raw);

    if (parsed.kind === 'fault') {
      throw mapXmlRpcFault(parsed.fault.faultCode, parsed.fault.faultString);
    }
    if (parsed.kind === 'call') {
      throw new ClientError('expected a methodResponse but received a methodCall');
    }
    return parsed.value;
  }

  /** Release the underlying TLS dispatcher, if any. */
  public async close(): Promise<void> {
    if (this.dispatcher) {
      await this.dispatcher.close();
    }
  }
}
