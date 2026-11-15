/**
 * Session lifecycle manager for the JSON-RPC client. Owns the current session
 * id, performs login/renew/logout, applies a session-age guard to avoid
 * needless renews, and spaces failed logins with a capped exponential backoff.
 *
 * Recovery rules (a CCU reboot wipes every session):
 * - a failed login opens a backoff window of min(1 s · 2^(n-1), 5 min); a login
 *   asked for inside it fails fast with {@link LoginBackoffError} and sends
 *   nothing. There is no permanent lockout: once the window passes, the next
 *   call tries again. A success, or {@link SessionManager.resetBackoff} (the
 *   CCU answered again), closes the window.
 * - concurrent callers share one login and one renew, so a burst of N calls
 *   is one request to the CCU, one session, and one failure at most.
 * - a renew that does not answer `true` drops the session; a call refused as
 *   `access denied` through {@link SessionManager.boundClient} drops it, logs
 *   in again and retries once. A stale id is never reused.
 */
import { JsonRpcMethod } from './methods.js';
import { AuthFailureError, LoginBackoffError } from '../../support/errors.js';

/** The JSON-RPC contract the session needs; {@link JsonRpcClient} satisfies it. */
export interface SessionPostClient {
  post(
    method: string,
    params?: Record<string, unknown>,
    opts?: { readonly sessionId?: string },
  ): Promise<unknown>;
}

/** Configuration for {@link SessionManager}. */
export interface SessionManagerOptions {
  readonly client: SessionPostClient;
  readonly username: string;
  readonly password: string;
  /** Seconds before a session is considered stale and renew is attempted. Default 90. */
  readonly sessionAgeSeconds?: number;
  /** Injectable clock in ms (for testability). Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_SESSION_AGE_SECONDS = 90;

/** Login backoff: 1 s, 2 s, 4 s … capped at 5 min. */
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;
const BACKOFF_FACTOR = 2;

export class SessionManager {
  private readonly client: SessionPostClient;
  private readonly username: string;
  private readonly password: string;
  private readonly sessionAgeMs: number;
  private readonly now: () => number;

  private currentSessionId: string | undefined;
  private lastRefresh = 0;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;
  private inFlightLogin: Promise<string> | undefined;
  private inFlightEnsure: Promise<string> | undefined;

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
   * id, and return it. Inside an open backoff window it throws
   * {@link LoginBackoffError} without contacting the CCU. Concurrent calls
   * share one request.
   */
  public login(): Promise<string> {
    if (this.inFlightLogin !== undefined) return this.inFlightLogin;
    if (this.consecutiveFailures > 0 && this.now() < this.nextAttemptAt) {
      return Promise.reject(new LoginBackoffError(this.nextAttemptAt, this.consecutiveFailures));
    }
    const attempt = this.sendLogin().finally(() => {
      this.inFlightLogin = undefined;
    });
    this.inFlightLogin = attempt;
    return attempt;
  }

  /** Close the backoff window: the next login goes out at once (the CCU answered again). */
  public resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
  }

  /** Force a renew on the next {@link ensureSession} (the CCU may have restarted). */
  public markStale(): void {
    this.lastRefresh = Number.NEGATIVE_INFINITY;
  }

  /**
   * Renew the current session if it is older than the session-age window. If it
   * was refreshed recently this is a no-op. A renew that does not answer `true`
   * or is refused drops the session and logs in again; a renew that fails for
   * another reason (CCU unreachable) drops the session and rethrows, so the
   * next call logs in instead of reusing an id the CCU may have forgotten.
   */
  public async renew(): Promise<void> {
    const id = this.currentSessionId;
    if (id === undefined) {
      await this.login();
      return;
    }

    if (this.now() - this.lastRefresh < this.sessionAgeMs) {
      return;
    }

    let result: unknown;
    try {
      result = await this.client.post(JsonRpcMethod.SESSION_RENEW, undefined, { sessionId: id });
    } catch (err) {
      this.dropSession(id);
      if (err instanceof AuthFailureError) {
        // Best-effort: the CCU refused the id, a logout of it may fail too.
        await this.client
          .post(JsonRpcMethod.SESSION_LOGOUT, undefined, { sessionId: id })
          .catch(() => undefined);
        await this.login();
        return;
      }
      throw err;
    }
    if (result === true) {
      this.lastRefresh = this.now();
      return;
    }
    this.dropSession(id);
    await this.login();
  }

  /**
   * Log out the current session (best-effort) and clear it. No-op if none. A
   * login still in flight is awaited first, so its session is logged out too.
   */
  public async logout(): Promise<void> {
    if (this.inFlightLogin !== undefined) {
      await this.inFlightLogin.catch(() => undefined);
    }
    const id = this.currentSessionId;
    if (id === undefined) return;
    this.currentSessionId = undefined;
    await this.client.post(JsonRpcMethod.SESSION_LOGOUT, undefined, { sessionId: id });
  }

  /** Ensure a usable session exists: login if none, else renew. Returns the id. Concurrent calls share one pass. */
  public ensureSession(): Promise<string> {
    if (this.inFlightEnsure !== undefined) return this.inFlightEnsure;
    const pass = this.runEnsure().finally(() => {
      this.inFlightEnsure = undefined;
    });
    this.inFlightEnsure = pass;
    return pass;
  }

  /**
   * A client that sends through this session: a call carrying a session id that
   * the CCU refuses as `access denied` drops that session, logs in again and is
   * retried once with the new id. Calls without a session id pass through.
   */
  public boundClient(): SessionPostClient {
    return {
      post: async (method, params, opts) => {
        const sid = opts?.sessionId;
        if (sid === undefined) return this.client.post(method, params, opts);
        try {
          return await this.client.post(method, params, opts);
        } catch (err) {
          if (!(err instanceof AuthFailureError)) throw err;
          this.dropSession(sid);
          const fresh = await this.ensureSession();
          return this.client.post(method, params, { sessionId: fresh });
        }
      },
    };
  }

  private async runEnsure(): Promise<string> {
    if (this.currentSessionId === undefined) {
      return this.login();
    }
    await this.renew();
    if (this.currentSessionId === undefined) {
      return this.login();
    }
    return this.currentSessionId;
  }

  private async sendLogin(): Promise<string> {
    try {
      const result = await this.client.post(JsonRpcMethod.SESSION_LOGIN, {
        username: this.username,
        password: this.password,
      });
      const id = String(result);
      this.currentSessionId = id;
      this.lastRefresh = this.now();
      this.resetBackoff();
      return id;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.nextAttemptAt = this.now() + this.backoffDelayMs();
      throw err;
    }
  }

  /** Forget `id` if it is still the current session (a newer one stays). */
  private dropSession(id: string): void {
    if (this.currentSessionId === id) this.currentSessionId = undefined;
  }

  private backoffDelayMs(): number {
    const exp = INITIAL_BACKOFF_MS * BACKOFF_FACTOR ** (this.consecutiveFailures - 1);
    return Math.min(exp, MAX_BACKOFF_MS);
  }
}
