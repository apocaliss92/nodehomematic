import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../../../../src/transport/jsonrpc/session.js';
import { JsonRpcMethod, SESSION_ID_PARAM } from '../../../../src/transport/jsonrpc/methods.js';
import {
  AuthFailureError,
  LoginBackoffError,
  NoConnectionError,
} from '../../../../src/support/errors.js';
import type { JsonRpcClient } from '../../../../src/transport/jsonrpc/client.js';

interface PostCall {
  method: string;
  params?: Record<string, unknown>;
  opts?: { sessionId?: string };
}

/** Minimal stub of JsonRpcClient that records calls and returns scripted results. */
class FakeClient {
  public readonly calls: PostCall[] = [];
  private readonly matchers = new Map<string, (c: PostCall) => Promise<unknown>>();

  public when(method: string, fn: (c: PostCall) => Promise<unknown>): void {
    this.matchers.set(method, fn);
  }

  public post(
    method: string,
    params?: Record<string, unknown>,
    opts?: { sessionId?: string },
  ): Promise<unknown> {
    const call: PostCall = { method, params, opts };
    this.calls.push(call);
    const matching = this.matchers.get(method);
    if (matching) return matching(call);
    return Promise.resolve(true);
  }

  public asClient(): JsonRpcClient {
    return this as unknown as JsonRpcClient;
  }
}

let fake: FakeClient;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  fake = new FakeClient();
  clock = 1_000_000;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionManager.login', () => {
  it('logs in with username/password and NO _session_id_, storing the id', async () => {
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve('SID-1'));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    const id = await mgr.login();
    expect(id).toBe('SID-1');
    expect(mgr.sessionId).toBe('SID-1');
    const loginCall = fake.calls.find((c) => c.method === JsonRpcMethod.SESSION_LOGIN);
    expect(loginCall?.params).toEqual({ username: 'admin', password: 'pw' });
    expect(loginCall?.opts?.sessionId).toBeUndefined();
    expect(loginCall?.params?.[SESSION_ID_PARAM]).toBeUndefined();
  });
});

describe('SessionManager.ensureSession / renew', () => {
  it('does not call Session.renew when called again within sessionAgeSeconds', async () => {
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve('SID-1'));
    fake.when(JsonRpcMethod.SESSION_RENEW, () => Promise.resolve(true));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      sessionAgeSeconds: 90,
      now,
    });
    await mgr.ensureSession();
    clock += 30_000; // 30s < 90s
    await mgr.ensureSession();
    const renews = fake.calls.filter((c) => c.method === JsonRpcMethod.SESSION_RENEW);
    expect(renews).toHaveLength(0);
  });

  it('calls Session.renew after the session age elapses', async () => {
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve('SID-1'));
    fake.when(JsonRpcMethod.SESSION_RENEW, () => Promise.resolve(true));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      sessionAgeSeconds: 90,
      now,
    });
    await mgr.ensureSession();
    clock += 91_000; // > 90s
    await mgr.ensureSession();
    const renews = fake.calls.filter((c) => c.method === JsonRpcMethod.SESSION_RENEW);
    expect(renews).toHaveLength(1);
    expect(renews[0]?.opts?.sessionId).toBe('SID-1');
  });

  it('on AuthFailure during renew, logs out then logs in afresh', async () => {
    let loginCount = 0;
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => {
      loginCount += 1;
      return Promise.resolve(`SID-${loginCount}`);
    });
    fake.when(JsonRpcMethod.SESSION_RENEW, () => Promise.reject(new AuthFailureError('denied')));
    fake.when(JsonRpcMethod.SESSION_LOGOUT, () => Promise.resolve(true));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      sessionAgeSeconds: 90,
      now,
    });
    await mgr.ensureSession(); // SID-1
    clock += 91_000;
    const id = await mgr.ensureSession(); // renew fails → logout + login
    expect(id).toBe('SID-2');
    expect(fake.calls.some((c) => c.method === JsonRpcMethod.SESSION_LOGOUT)).toBe(true);
    expect(loginCount).toBe(2);
  });

  it('rethrows a non-auth error raised during renew', async () => {
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve('SID-1'));
    fake.when(JsonRpcMethod.SESSION_RENEW, () => Promise.reject(new NoConnectionError('down')));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      sessionAgeSeconds: 90,
      now,
    });
    await mgr.ensureSession();
    clock += 91_000;
    await expect(mgr.renew()).rejects.toBeInstanceOf(NoConnectionError);
  });

  it('renew() with no session falls back to a fresh login', async () => {
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve('SID-NEW'));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    await mgr.renew();
    expect(mgr.sessionId).toBe('SID-NEW');
  });
});

describe('SessionManager.logout', () => {
  it('calls Session.logout with the session id and clears it', async () => {
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve('SID-1'));
    fake.when(JsonRpcMethod.SESSION_LOGOUT, () => Promise.resolve(true));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    await mgr.login();
    await mgr.logout();
    const logout = fake.calls.find((c) => c.method === JsonRpcMethod.SESSION_LOGOUT);
    expect(logout?.opts?.sessionId).toBe('SID-1');
    expect(mgr.sessionId).toBeUndefined();
  });

  it('is a no-op when there is no active session', async () => {
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    await mgr.logout();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('SessionManager login backoff', () => {
  function failingManager(): { mgr: SessionManager; setUp: (up: boolean) => void } {
    let up = false;
    fake.when(JsonRpcMethod.SESSION_LOGIN, () =>
      up ? Promise.resolve('SID-BACK') : Promise.reject(new NoConnectionError('down')),
    );
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    return { mgr, setUp: (value) => void (up = value) };
  }

  /** Fail `count` real login attempts, each once the previous window has passed. */
  async function failLogins(mgr: SessionManager, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      clock += 300_000;
      await expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
    }
  }

  function loginCalls(): number {
    return fake.calls.filter((c) => c.method === JsonRpcMethod.SESSION_LOGIN).length;
  }

  it('never locks out: after 12 failures a login is attempted again once the window passed', async () => {
    const { mgr, setUp } = failingManager();
    await failLogins(mgr, 12);
    expect(loginCalls()).toBe(12);
    setUp(true);
    clock += 300_000;
    await expect(mgr.login()).resolves.toBe('SID-BACK');
    expect(loginCalls()).toBe(13);
  });

  it('fails fast inside the window with a typed error naming the next attempt', async () => {
    const { mgr } = failingManager();
    await expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
    clock += 1_000;
    await expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
    // Two failures: the window is 2 s from the last one, nothing is sent until then.
    const before = loginCalls();
    const err = await mgr.login().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LoginBackoffError);
    expect(err instanceof LoginBackoffError ? err.retryAt : 0).toBe(clock + 2_000);
    expect(loginCalls()).toBe(before);
    clock += 2_000;
    await expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
    expect(loginCalls()).toBe(before + 1);
  });

  it('caps the window at 5 minutes', async () => {
    const { mgr, setUp } = failingManager();
    await failLogins(mgr, 20);
    setUp(true);
    clock += 299_999;
    await expect(mgr.login()).rejects.toBeInstanceOf(LoginBackoffError);
    clock += 1;
    await expect(mgr.login()).resolves.toBe('SID-BACK');
  });

  it('resetBackoff lets the next login go out at once (the CCU answered again)', async () => {
    const { mgr, setUp } = failingManager();
    await failLogins(mgr, 11);
    await expect(mgr.login()).rejects.toBeInstanceOf(LoginBackoffError);
    setUp(true);
    mgr.resetBackoff();
    await expect(mgr.login()).resolves.toBe('SID-BACK');
  });

  it('a success resets the backoff', async () => {
    const { mgr, setUp } = failingManager();
    await failLogins(mgr, 5);
    setUp(true);
    clock += 300_000;
    await mgr.login();
    setUp(false);
    await expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
    clock += 1_000;
    await expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
  });

  it('concurrent callers share ONE login (no burst, no leaked sessions)', async () => {
    let n = 0;
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve(`SID-${++n}`));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    const ids = await Promise.all(Array.from({ length: 30 }, () => mgr.ensureSession()));
    expect(new Set(ids)).toEqual(new Set(['SID-1']));
    expect(loginCalls()).toBe(1);
  });

  it('concurrent failing callers count as ONE failure', async () => {
    const { mgr, setUp } = failingManager();
    const all = await Promise.allSettled(Array.from({ length: 30 }, () => mgr.ensureSession()));
    expect(all.every((r) => r.status === 'rejected')).toBe(true);
    expect(loginCalls()).toBe(1);
    setUp(true);
    clock += 1_000;
    await expect(mgr.ensureSession()).resolves.toBe('SID-BACK');
  });
});

describe('SessionManager stale sessions', () => {
  it('a renew answered false drops the session and logs in again', async () => {
    let n = 0;
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve(`SID-${++n}`));
    fake.when(JsonRpcMethod.SESSION_RENEW, () => Promise.resolve(false));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    await mgr.login();
    clock += 91_000;
    await expect(mgr.ensureSession()).resolves.toBe('SID-2');
  });

  it('a renew refused as access denied logs in even when the logout of the dead session fails', async () => {
    let n = 0;
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve(`SID-${++n}`));
    fake.when(JsonRpcMethod.SESSION_RENEW, () =>
      Promise.reject(new AuthFailureError('access denied')),
    );
    fake.when(JsonRpcMethod.SESSION_LOGOUT, () =>
      Promise.reject(new AuthFailureError('access denied')),
    );
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    await mgr.login();
    clock += 91_000;
    await expect(mgr.ensureSession()).resolves.toBe('SID-2');
  });

  it('markStale forces a renew on the next ensureSession', async () => {
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve('SID-1'));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    await mgr.login();
    mgr.markStale();
    await mgr.ensureSession();
    expect(fake.calls.filter((c) => c.method === JsonRpcMethod.SESSION_RENEW)).toHaveLength(1);
  });

  it('the session-bound client re-logs in and retries once on access denied', async () => {
    let n = 0;
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.resolve(`SID-${++n}`));
    fake.when('ReGa.runScript', (c) =>
      c.opts?.sessionId === 'SID-1'
        ? Promise.reject(new AuthFailureError('access denied'))
        : Promise.resolve('ok'),
    );
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    const sid = await mgr.ensureSession();
    await expect(mgr.boundClient().post('ReGa.runScript', {}, { sessionId: sid })).resolves.toBe(
      'ok',
    );
    expect(mgr.sessionId).toBe('SID-2');
  });

  it('logout waits for an in-flight login so the new session is not leaked', async () => {
    let resolveLogin: (v: string) => void = () => undefined;
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => new Promise<string>((r) => (resolveLogin = r)));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });
    const pending = mgr.login();
    const out = mgr.logout();
    resolveLogin('SID-LATE');
    await pending;
    await out;
    const logout = fake.calls.find((c) => c.method === JsonRpcMethod.SESSION_LOGOUT);
    expect(logout?.opts?.sessionId).toBe('SID-LATE');
    expect(mgr.sessionId).toBeUndefined();
  });
});
