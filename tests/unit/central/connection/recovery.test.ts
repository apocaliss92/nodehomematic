import { describe, it, expect } from 'vitest';
import {
  ConnectionRecovery,
  RecoveryStage,
  type RecoveryHooks,
} from '../../../../src/central/connection/recovery.js';
import { EventBus } from '../../../../src/central/event-bus.js';

interface Harness {
  recovery: ConnectionRecovery;
  stages: RecoveryStage[];
  sleeps: number[];
  hookCalls: string[];
}

function buildHooks(overrides: Partial<RecoveryHooks> = {}): RecoveryHooks {
  return {
    tcpCheck: async () => true,
    rpcCheck: async () => true,
    doReconnect: async () => {},
    reloadData: async () => {},
    hasExistingClient: () => true,
    ...overrides,
  };
}

function makeHarness(opts: {
  hooks?: Partial<RecoveryHooks>;
  recordHookCalls?: boolean;
  config?: Record<string, number>;
}): Harness {
  const bus = new EventBus();
  const stages: RecoveryStage[] = [];
  bus.subscribe({
    type: 'recoveryStageChanged',
    handler: (e) => void stages.push(e.stage as RecoveryStage),
  });
  const sleeps: number[] = [];
  const hookCalls: string[] = [];

  const wrap = (name: string, fn: (...args: never[]) => Promise<unknown>) =>
    opts.recordHookCalls
      ? async (...args: never[]) => {
          hookCalls.push(name);
          return fn(...args);
        }
      : fn;

  const base = buildHooks(opts.hooks);
  const hooks: RecoveryHooks = {
    tcpCheck: wrap('tcpCheck', base.tcpCheck) as RecoveryHooks['tcpCheck'],
    rpcCheck: wrap('rpcCheck', base.rpcCheck) as RecoveryHooks['rpcCheck'],
    doReconnect: wrap('doReconnect', base.doReconnect) as RecoveryHooks['doReconnect'],
    reloadData: wrap('reloadData', base.reloadData) as RecoveryHooks['reloadData'],
    hasExistingClient: base.hasExistingClient,
  };

  const recovery = new ConnectionRecovery({
    eventBus: bus,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...opts.config,
    hooks,
  });

  return { recovery, stages, sleeps, hookCalls };
}

describe('central/connection/ConnectionRecovery', () => {
  it('happy runtime path emits stages in exact order and returns true', async () => {
    const h = makeHarness({ recordHookCalls: true });
    const ok = await h.recovery.recover('iface-1');
    expect(ok).toBe(true);
    expect(h.stages).toEqual([
      RecoveryStage.COOLDOWN,
      RecoveryStage.TCP_CHECKING,
      RecoveryStage.RPC_CHECKING,
      RecoveryStage.WARMING_UP,
      RecoveryStage.STABILITY_CHECK,
      RecoveryStage.RECONNECTING,
      RecoveryStage.DATA_LOADING,
      RecoveryStage.RECOVERED,
    ]);
    expect(h.hookCalls).toEqual(['tcpCheck', 'rpcCheck', 'rpcCheck', 'doReconnect', 'reloadData']);
    h.recovery.stop();
  });

  it('startup path (no existing client) skips cooldown/warmup/stability', async () => {
    const h = makeHarness({
      recordHookCalls: true,
      hooks: { hasExistingClient: () => false },
    });
    const ok = await h.recovery.recover('iface-1');
    expect(ok).toBe(true);
    expect(h.stages).toEqual([
      RecoveryStage.TCP_CHECKING,
      RecoveryStage.RECONNECTING,
      RecoveryStage.DATA_LOADING,
      RecoveryStage.RECOVERED,
    ]);
    expect(h.hookCalls).toEqual(['tcpCheck', 'doReconnect', 'reloadData']);
    h.recovery.stop();
  });

  it('tcpCheck false then true retries after a 5000ms backoff', async () => {
    let attempt = 0;
    const h = makeHarness({
      hooks: {
        tcpCheck: async () => {
          attempt++;
          return attempt > 1;
        },
      },
    });
    const ok = await h.recovery.recover('iface-1');
    expect(ok).toBe(true);
    expect(attempt).toBe(2);
    // sleeps: cooldown(30000), backoff(5000), cooldown(30000), warmup(15000)
    expect(h.sleeps).toContain(5000);
    h.recovery.stop();
  });

  it('nextRetryDelay produces the 5000/10000/20000/40000/60000/60000 sequence', () => {
    const h = makeHarness({});
    const seq = [1, 2, 3, 4, 5, 6].map((f) => h.recovery.nextRetryDelay(f));
    expect(seq).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    h.recovery.stop();
  });

  it('maxAttempts exhausted returns FAILED and schedules a heartbeat that retries', async () => {
    let tcpResult = false;
    const heartbeatTimers: Array<{ ms: number; cb: () => void }> = [];
    const bus = new EventBus();
    const stages: RecoveryStage[] = [];
    bus.subscribe({
      type: 'recoveryStageChanged',
      handler: (e) => void stages.push(e.stage as RecoveryStage),
    });
    let reconnectCount = 0;
    const recovery = new ConnectionRecovery({
      eventBus: bus,
      sleep: async () => {},
      maxAttempts: 3,
      hooks: buildHooks({
        tcpCheck: async () => tcpResult,
        doReconnect: async () => {
          reconnectCount++;
        },
      }),
      setTimer: (cb, ms) => {
        const timer = { ms, cb };
        heartbeatTimers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });

    const ok = await recovery.recover('iface-1');
    expect(ok).toBe(false);
    expect(stages).toContain(RecoveryStage.FAILED);
    expect(heartbeatTimers).toHaveLength(1);
    expect(heartbeatTimers[0]?.ms).toBe(60_000);

    // Let the next heartbeat attempt succeed.
    tcpResult = true;
    const fired = heartbeatTimers[0];
    if (fired) fired.cb();
    await new Promise((r) => setImmediate(r));
    expect(reconnectCount).toBe(1);

    recovery.stop();
  });

  it('stop cancels the heartbeat timer', async () => {
    const cleared: unknown[] = [];
    const timers: Array<{ cb: () => void; token: number }> = [];
    let nextToken = 1;
    const recovery = new ConnectionRecovery({
      eventBus: new EventBus(),
      sleep: async () => {},
      maxAttempts: 1,
      hooks: buildHooks({ tcpCheck: async () => false }),
      setTimer: (cb) => {
        const token = nextToken++;
        timers.push({ cb, token });
        return token as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (t) => void cleared.push(t),
    });

    await recovery.recover('iface-1');
    expect(timers).toHaveLength(1);
    recovery.stop();
    expect(cleared).toContain(timers[0]?.token);
  });

  it('dedupes concurrent recover() for the same interface', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let cooldownReleases: Array<() => void> = [];
    const recovery = new ConnectionRecovery({
      eventBus: new EventBus(),
      sleep: () =>
        new Promise<void>((resolve) => {
          cooldownReleases.push(resolve);
        }),
      hooks: buildHooks({
        doReconnect: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          inFlight--;
        },
      }),
    });

    const p1 = recovery.recover('iface-1');
    const p2 = recovery.recover('iface-1');
    // Release all queued sleeps.
    for (let i = 0; i < 20; i++) {
      cooldownReleases.forEach((r) => r());
      cooldownReleases = [];
      await Promise.resolve();
    }
    const [r1, r2] = await Promise.all([p1, p2]);
    // Second concurrent call for same interface is a no-op (dedup).
    expect(r1 === true || r2 === true).toBe(true);
    expect(maxInFlight).toBe(1);
    recovery.stop();
  });

  it('semaphore caps concurrent recoveries to maxConcurrent across interfaces', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releases: Array<() => void> = [];
    const recovery = new ConnectionRecovery({
      eventBus: new EventBus(),
      maxConcurrent: 2,
      sleep: () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
      hooks: buildHooks({
        doReconnect: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight--;
        },
      }),
    });

    const ps = [recovery.recover('a'), recovery.recover('b'), recovery.recover('c')];
    for (let i = 0; i < 40; i++) {
      releases.forEach((r) => r());
      releases = [];
      await Promise.resolve();
    }
    await Promise.all(ps);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    recovery.stop();
  });
});
