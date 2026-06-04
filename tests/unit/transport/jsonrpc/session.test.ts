import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../../../../src/transport/jsonrpc/session.js';
import { JsonRpcMethod, SESSION_ID_PARAM } from '../../../../src/transport/jsonrpc/methods.js';
import { AuthFailureError, NoConnectionError } from '../../../../src/support/errors.js';
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

describe('SessionManager login rate limiting', () => {
  it('after 10 consecutive failed logins throws and stops retrying', async () => {
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => Promise.reject(new NoConnectionError('down')));
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });

    for (let i = 0; i < 10; i += 1) {
      // Attach the rejection assertion BEFORE advancing timers so the
      // rejection is never momentarily unhandled.
      const assertion = expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    }

    // The 11th attempt is rejected without hitting the network again.
    const before = fake.calls.length;
    await expect(mgr.login()).rejects.toBeTruthy();
    expect(fake.calls.length).toBe(before);
  });

  it('resets the failure counter after a successful login', async () => {
    let fail = true;
    fake.when(JsonRpcMethod.SESSION_LOGIN, () => {
      if (fail) return Promise.reject(new NoConnectionError('down'));
      return Promise.resolve('SID-OK');
    });
    const mgr = new SessionManager({
      client: fake.asClient(),
      username: 'admin',
      password: 'pw',
      now,
    });

    // A few failures (under the cap).
    for (let i = 0; i < 3; i += 1) {
      const assertion = expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    }
    fail = false;
    const success = expect(mgr.login()).resolves.toBe('SID-OK');
    await vi.advanceTimersByTimeAsync(60_000);
    await success;

    // Counter reset: another full run of failures must again be allowed.
    fail = true;
    for (let i = 0; i < 9; i += 1) {
      const assertion = expect(mgr.login()).rejects.toBeInstanceOf(NoConnectionError);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    }
  });
});
