/**
 * JSON-RPC HTTP client for the CCU WebUI (`/api/homematic.cgi`). Builds the
 * Homematic JSON-RPC 1.1 envelope, coerces every param to a string (the CCU
 * expects all-string params), POSTs it, parses the `{result, error, id}`
 * response, and maps errors / transport failures to typed errors.
 *
 * A small semaphore caps the number of concurrent in-flight POSTs, mirroring
 * aiohomematic's `MAX_CONCURRENT_HTTP_SESSIONS`.
 */
import { Agent, fetch, type RequestInit } from 'undici';
import {
  ClientError,
  mapJsonRpcError,
  mapTransportError,
  type JsonRpcErrorLike,
} from '../../support/errors.js';
import { JSON_RPC_PATH, TIMEOUTS } from '../../support/constants.js';
import { SESSION_ID_PARAM } from './methods.js';

/** TLS options for HTTPS endpoints (e.g. CCU self-signed certificates). */
export interface JsonRpcTlsOptions {
  /** When false, accept self-signed / untrusted certificates. Defaults to true. */
  readonly rejectUnauthorized?: boolean;
}

/** Configuration for {@link JsonRpcClient}. */
export interface JsonRpcClientOptions {
  /** Base device URL, e.g. `http://ccu` (the client appends {@link JSON_RPC_PATH}). */
  readonly url: string;
  /** Optional TLS settings for HTTPS endpoints. */
  readonly tls?: JsonRpcTlsOptions;
  /** Max concurrent in-flight POSTs. Defaults to 3. */
  readonly maxConcurrent?: number;
  /** Per-request timeout in milliseconds. Defaults to {@link TIMEOUTS.rpc}. */
  readonly timeoutMs?: number;
}

/** Per-call options. */
export interface JsonRpcPostOptions {
  /** When provided, injected into the params as `_session_id_`. */
  readonly sessionId?: string;
}

/** Shape of a CCU JSON-RPC response envelope. */
interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: JsonRpcErrorLike | null;
  readonly id?: number;
}

const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Coerce every param value to a string. Booleans become "true"/"false",
 * numbers become their decimal string form. Non-null objects/arrays are
 * JSON.stringify-ed (so they do not collapse to "[object Object]"); for the
 * common case all values are primitives.
 */
function stringifyParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/** A minimal FIFO semaphore limiting concurrent async sections. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  public constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  public async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  public release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Permit is handed directly to the next waiter (count stays consumed).
      next();
    } else {
      this.available += 1;
    }
  }
}

/**
 * JSON-RPC client. One instance targets a single base URL. Stateless apart from
 * its config, an optional reusable TLS dispatcher, and the concurrency
 * semaphore.
 */
export class JsonRpcClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Agent | undefined;
  private readonly semaphore: Semaphore;

  public constructor(options: JsonRpcClientOptions) {
    // url is a base URL; append the JSON-RPC path (strip any trailing slash).
    const base = options.url.replace(/\/+$/, '');
    this.endpoint = `${base}${JSON_RPC_PATH}`;
    this.timeoutMs = options.timeoutMs ?? TIMEOUTS.rpc;
    this.semaphore = new Semaphore(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    if (options.tls?.rejectUnauthorized === false) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    } else {
      this.dispatcher = undefined;
    }
  }

  /**
   * Invoke a JSON-RPC method and return the parsed `result`. Throws a typed
   * error on a truthy `error` field or on a transport failure.
   */
  public async post(
    method: string,
    params?: Record<string, unknown>,
    opts?: JsonRpcPostOptions,
  ): Promise<unknown> {
    const merged: Record<string, unknown> = { ...(params ?? {}) };
    if (opts?.sessionId !== undefined) {
      merged[SESSION_ID_PARAM] = opts.sessionId;
    }

    const envelope = {
      method,
      params: stringifyParams(merged),
      jsonrpc: '1.1',
      id: 0,
    };
    const body = Buffer.from(JSON.stringify(envelope), 'utf-8');

    await this.semaphore.acquire();
    try {
      return await this.send(body);
    } finally {
      this.semaphore.release();
    }
  }

  private async send(body: Buffer): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let raw: Buffer;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      };
      if (this.dispatcher) init.dispatcher = this.dispatcher;

      const response = await fetch(this.endpoint, init);
      const arrayBuffer = await response.arrayBuffer();
      raw = Buffer.from(arrayBuffer);
    } catch (err) {
      // Network/connection/abort failures become NoConnectionError (via mapper).
      throw mapTransportError(err);
    } finally {
      clearTimeout(timer);
    }

    if (raw.length === 0) {
      throw new ClientError('JSON-RPC response had an empty body');
    }

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(raw.toString('utf-8')) as JsonRpcResponse;
    } catch {
      throw new ClientError('JSON-RPC response was not valid JSON');
    }

    if (parsed.error) {
      throw mapJsonRpcError(parsed.error);
    }
    return parsed.result;
  }

  /** Release the underlying TLS dispatcher, if any. */
  public async close(): Promise<void> {
    if (this.dispatcher) {
      await this.dispatcher.close();
    }
  }
}
