/**
 * Minimal HTTP transport for the CCU WebUI's HMServer pages
 * (`/pages/jpages/...`), which are NOT JSON-RPC: the WebUI's own JavaScript
 * calls them as `Ajax.Request('/pages/jpages/group/save?sid=<session>')` with a
 * raw JSON body (Prototype `postBody`) on the same origin as `/api/homematic.cgi`.
 *
 * The session id is the one the JSON-RPC {@link SessionManager} already owns; it
 * travels only in the query string and is NEVER placed in an error message.
 */
import { Agent, fetch as undiciFetch, type RequestInit } from 'undici';
import { CcuManagementError, ClientError, mapTransportError } from '../../support/errors.js';
import { TIMEOUTS } from '../../support/constants.js';

/** What the group management needs from the WebUI HTTP layer. */
export interface WebUiHttp {
  get(path: string, sessionId: string): Promise<string>;
  post(path: string, sessionId: string, body: string): Promise<string>;
}

/** Injectable fetch (tests). */
export type WebUiFetch = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Record<string, string>;
    readonly body: string | undefined;
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** Options for {@link WebUiHttpClient}. */
export interface WebUiHttpClientOptions {
  /** Base URL of the CCU, e.g. `http://ccu` (no port: the WebUI answers on 80/443). */
  readonly url: string;
  readonly rejectUnauthorized?: boolean;
  readonly timeoutMs?: number;
  readonly fetch?: WebUiFetch;
}

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';
const ESCAPE_SAFE = /[A-Za-z0-9@*_+\-./]/;

/**
 * JavaScript's legacy `escape()`: the WebUI sends the group name through it
 * (`data.groupName = escape(viewModel.groupName())`).
 */
export function jsEscape(text: string): string {
  let out = '';
  for (const ch of text) {
    const unit = ch.charCodeAt(0);
    if (ESCAPE_SAFE.test(ch)) out += ch;
    else if (ch.length === 1 && unit < 256)
      out += `%${unit.toString(16).toUpperCase().padStart(2, '0')}`;
    else
      for (let i = 0; i < ch.length; i += 1) {
        out += `%u${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
      }
  }
  return out;
}

export class WebUiHttpClient implements WebUiHttp {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: WebUiFetch;
  private readonly dispatcher: Agent | undefined;

  public constructor(options: WebUiHttpClientOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? TIMEOUTS.rpc;
    this.dispatcher =
      options.rejectUnauthorized === false
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : undefined;
    this.fetchFn = options.fetch ?? this.defaultFetch.bind(this);
  }

  public get(path: string, sessionId: string): Promise<string> {
    return this.request('GET', path, sessionId, undefined);
  }

  public post(path: string, sessionId: string, body: string): Promise<string> {
    return this.request('POST', path, sessionId, body);
  }

  public async close(): Promise<void> {
    await this.dispatcher?.close();
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    sessionId: string,
    body: string | undefined,
  ): Promise<string> {
    const url = `${this.base}${path}?sid=${encodeURIComponent(sessionId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': FORM_CONTENT_TYPE },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status < 200 || response.status >= 300) {
        throw new ClientError(`HTTP ${response.status}`);
      }
      return text;
    } catch (err) {
      // Never forward the raw error text: it may echo the URL, and the URL holds the sid.
      const mapped = err instanceof ClientError ? err : mapTransportError(err);
      throw new CcuManagementError(
        `${method} ${path}`,
        new Error(`${mapped.name}: ${mapped.message.split(sessionId).join('<sid>')}`),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async defaultFetch(url: string, init: Parameters<WebUiFetch>[1]): ReturnType<WebUiFetch> {
    const req: RequestInit = { method: init.method, headers: init.headers, signal: init.signal };
    if (init.body !== undefined) req.body = init.body;
    if (this.dispatcher) req.dispatcher = this.dispatcher;
    return undiciFetch(url, req);
  }
}
