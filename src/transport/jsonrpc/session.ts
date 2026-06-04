/**
 * Session lifecycle manager for the JSON-RPC client. Owns the current session
 * id, performs login/renew/logout, applies a session-age guard to avoid
 * needless renews, and rate-limits failed logins with exponential backoff.
 */
import { JsonRpcClient } from './client.js';
import { JsonRpcMethod } from './methods.js';
import { AuthFailureError, BaseHomematicError } from '../../support/errors.js';

/** Configuration for {@link SessionManager}. */
export interface SessionManagerOptions {
  readonly client: JsonRpcClient;
  readonly username: string;
  readonly password: string;
  /** Seconds before a session is considered stale and renew is attempted. Default 90. */
  readonly sessionAgeSeconds?: number;
  /** Injectable monotonic-ish clock in ms (for testability). Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_SESSION_AGE_SECONDS = 90;

/** Login backoff parameters (mirrors aiohomematic). */
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_FACTOR = 2;
const MAX_CONSECUTIVE_FAILURES = 10;

/** Resolve after `ms`, using the global timer (patchable by fake timers in tests). */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class SessionManager {
  private readonly client: JsonRpcClient;
  private readonly username: string;
  private readonly password: string;
  private readonly sessionAgeMs: number;
  private readonly now: () => number;

  private currentSessionId: string | undefined;
  private lastRefresh = 0;
  private consecutiveFailures = 0;

  public constructor(options: SessionManagerOptions) {
    this.client = options.client;
    this.username = options.username;
    this.password = options.password;
    this.sessionAgeMs = (options.sessionAgeSeconds ?? DEFAULT_SESSION_AGE_SECONDS) * 1000;
    this.now = options.now ?? ((): number => Date.now());
  }

  /** The current session id, or `undefined` if not logged in. */
  public get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  /**
   * Log in with username/password (no session id), store the resulting session
   * id, and return it. Applies failed-login rate limiting: each consecutive
   * failure waits an exponentially growing backoff (1s → 60s); after
   * {@link MAX_CONSECUTIVE_FAILURES} failures it throws without contacting the
   * backend. A success resets the failure counter.
   */
  public async login(): Promise<string> {
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new BaseHomematicError(
        `login rate limit reached after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
      );
    }

    if (this.consecutiveFailures > 0) {
      await delay(this.backoffDelayMs());
    }

    try {
      const result = await this.client.post(JsonRpcMethod.SESSION_LOGIN, {
        username: this.username,
        password: this.password,
      });
      const id = String(result);
      this.currentSessionId = id;
      this.lastRefresh = this.now();
      this.consecutiveFailures = 0;
      return id;
    } catch (err) {
      this.consecutiveFailures += 1;
      throw err;
    }
  }

  /**
   * Renew the current session if it is older than the session-age window. If it
   * was refreshed recently this is a no-op. On {@link AuthFailureError} the old
   * session is logged out (best-effort) and a fresh login is performed.
   */
  public async renew(): Promise<void> {
    if (this.currentSessionId === undefined) {
      await this.login();
      return;
    }

    if (this.now() - this.lastRefresh < this.sessionAgeMs) {
      // Refreshed recently; skip.
      return;
    }

    try {
      const result = await this.client.post(JsonRpcMethod.SESSION_RENEW, undefined, {
        sessionId: this.currentSessionId,
      });
      if (result === true) {
        this.lastRefresh = this.now();
      }
    } catch (err) {
      if (err instanceof AuthFailureError) {
        await this.logout();
        await this.login();
        return;
      }
      throw err;
    }
  }

  /** Log out the current session (best-effort) and clear it. No-op if none. */
  public async logout(): Promise<void> {
    const id = this.currentSessionId;
    if (id === undefined) return;
    this.currentSessionId = undefined;
    await this.client.post(JsonRpcMethod.SESSION_LOGOUT, undefined, { sessionId: id });
  }

  /** Ensure a usable session exists: login if none, else renew. Returns the id. */
  public async ensureSession(): Promise<string> {
    if (this.currentSessionId === undefined) {
      return this.login();
    }
    await this.renew();
    // renew() may have re-logged-in; sessionId is guaranteed set on success.
    if (this.currentSessionId === undefined) {
      return this.login();
    }
    return this.currentSessionId;
  }

  private backoffDelayMs(): number {
    const exp = INITIAL_BACKOFF_MS * BACKOFF_FACTOR ** (this.consecutiveFailures - 1);
    return Math.min(exp, MAX_BACKOFF_MS);
  }
}
