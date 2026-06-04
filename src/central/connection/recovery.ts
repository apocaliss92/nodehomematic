/**
 * Rock-solid connection recovery.
 *
 * Drives a deterministic stage machine to bring an interface back online after
 * a loss, emitting `recoveryStageChanged` on the {@link EventBus} at every
 * transition. Two paths exist:
 *
 *  - **runtime** (an existing client is present):
 *    COOLDOWN → TCP_CHECKING → RPC_CHECKING → WARMING_UP → STABILITY_CHECK →
 *    RECONNECTING → DATA_LOADING → RECOVERED.
 *  - **startup** (no client yet): TCP_CHECKING → RECONNECTING → DATA_LOADING →
 *    RECOVERED.
 *
 * A failed attempt waits {@link ConnectionRecovery.nextRetryDelay} and retries
 * from the top; after `maxAttempts` the interface enters FAILED and a heartbeat
 * loop keeps retrying every `heartbeatMs` until success. A semaphore caps the
 * number of interfaces recovering concurrently, and concurrent `recover()`
 * calls for the *same* interface are deduplicated.
 *
 * Every wait goes through the injected `sleep`, and the heartbeat uses an
 * injectable timer, so the whole machine is deterministic under tests.
 */

import type { EventBus } from '../event-bus.js';

/** Ordered recovery stages emitted as `recoveryStageChanged`. */
export enum RecoveryStage {
  IDLE = 'IDLE',
  COOLDOWN = 'COOLDOWN',
  TCP_CHECKING = 'TCP_CHECKING',
  RPC_CHECKING = 'RPC_CHECKING',
  WARMING_UP = 'WARMING_UP',
  STABILITY_CHECK = 'STABILITY_CHECK',
  RECONNECTING = 'RECONNECTING',
  DATA_LOADING = 'DATA_LOADING',
  RECOVERED = 'RECOVERED',
  FAILED = 'FAILED',
}

/** Injectable side effects the recovery machine drives. */
export interface RecoveryHooks {
  /** Probe a raw TCP connection to the interface (resolves to reachability). */
  tcpCheck(interfaceId: string): Promise<boolean>;
  /** Probe RPC health (e.g. `system.listMethods`). */
  rpcCheck(interfaceId: string): Promise<boolean>;
  /** Re-initialise the client (deinit+init, resets the breaker). */
  doReconnect(interfaceId: string): Promise<void>;
  /** Re-sync values / hub data after a successful reconnect. */
  reloadData(interfaceId: string): Promise<void>;
  /** Whether a live client already exists (runtime path) or not (startup). */
  hasExistingClient(interfaceId: string): boolean;
}

/** Opaque timer handle returned by {@link RecoveryOptions.setTimer}. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Constructor options for {@link ConnectionRecovery}. */
export interface RecoveryOptions {
  readonly eventBus: EventBus;
  /** Injectable delay primitive; tests pass an immediate/recording stub. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly cooldownMs?: number;
  readonly warmupMs?: number;
  readonly tcpCheckTimeoutMs?: number;
  readonly baseRetryMs?: number;
  readonly maxRetryMs?: number;
  readonly maxAttempts?: number;
  readonly heartbeatMs?: number;
  /** Max interfaces recovering concurrently. */
  readonly maxConcurrent?: number;
  readonly hooks: RecoveryHooks;
  /** Injectable timer scheduler (defaults to `setTimeout`). */
  readonly setTimer?: (cb: () => void, ms: number) => TimerHandle;
  /** Injectable timer canceller (defaults to `clearTimeout`). */
  readonly clearTimer?: (handle: TimerHandle) => void;
}

const DEFAULTS = {
  cooldownMs: 30_000,
  warmupMs: 15_000,
  tcpCheckTimeoutMs: 2_000,
  baseRetryMs: 5_000,
  maxRetryMs: 60_000,
  maxAttempts: 8,
  heartbeatMs: 60_000,
  maxConcurrent: 2,
} as const;

export class ConnectionRecovery {
  private readonly eventBus: EventBus;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cooldownMs: number;
  private readonly warmupMs: number;
  private readonly tcpCheckTimeoutMs: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly maxAttempts: number;
  private readonly heartbeatMs: number;
  private readonly maxConcurrent: number;
  private readonly hooks: RecoveryHooks;
  private readonly setTimer: (cb: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  /** In-flight recover() promises keyed by interface (per-interface dedup). */
  private readonly running = new Map<string, Promise<boolean>>();
  /** Active heartbeat timers keyed by interface. */
  private readonly heartbeats = new Map<string, TimerHandle>();
  /** Set once {@link stop} is called; aborts loops and blocks new work. */
  private stopped = false;

  /** Concurrency semaphore state. */
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(options: RecoveryOptions) {
    this.eventBus = options.eventBus;
    this.sleep = options.sleep;
    this.cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
    this.warmupMs = options.warmupMs ?? DEFAULTS.warmupMs;
    this.tcpCheckTimeoutMs = options.tcpCheckTimeoutMs ?? DEFAULTS.tcpCheckTimeoutMs;
    this.baseRetryMs = options.baseRetryMs ?? DEFAULTS.baseRetryMs;
    this.maxRetryMs = options.maxRetryMs ?? DEFAULTS.maxRetryMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
    this.hooks = options.hooks;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  /**
   * Exponential backoff for the given (1-based) consecutive failure count:
   * `min(baseRetryMs * 2^(failures-1), maxRetryMs)`.
   */
  public nextRetryDelay(consecutiveFailures: number): number {
    const exp = Math.max(0, consecutiveFailures - 1);
    return Math.min(this.baseRetryMs * 2 ** exp, this.maxRetryMs);
  }

  /**
   * Recover an interface. Concurrent calls for the same interface return the
   * same in-flight promise. Resolves true once RECOVERED, false once FAILED
   * (after which a heartbeat loop continues retrying in the background).
   */
  public recover(interfaceId: string): Promise<boolean> {
    const existing = this.running.get(interfaceId);
    if (existing) return existing;

    const run = this.runRecovery(interfaceId).finally(() => {
      this.running.delete(interfaceId);
    });
    this.running.set(interfaceId, run);
    return run;
  }

  /** Cancel heartbeat timers and stop scheduling further work. */
  public stop(): void {
    this.stopped = true;
    for (const handle of this.heartbeats.values()) {
      this.clearTimer(handle);
    }
    this.heartbeats.clear();
    // Release anything blocked on the semaphore so promises settle.
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  private async runRecovery(interfaceId: string): Promise<boolean> {
    await this.acquire();
    try {
      let failures = 0;
      while (!this.stopped) {
        const ok = await this.attempt(interfaceId);
        if (ok) {
          await this.emit(interfaceId, RecoveryStage.RECOVERED);
          return true;
        }
        failures++;
        if (failures >= this.maxAttempts) {
          await this.emit(interfaceId, RecoveryStage.FAILED);
          this.scheduleHeartbeat(interfaceId);
          return false;
        }
        await this.sleep(this.nextRetryDelay(failures));
      }
      return false;
    } finally {
      this.release();
    }
  }

  /** Run a single recovery attempt; returns true if it reached RECOVERED. */
  private async attempt(interfaceId: string): Promise<boolean> {
    const runtime = this.hooks.hasExistingClient(interfaceId);

    if (runtime) {
      await this.emit(interfaceId, RecoveryStage.COOLDOWN);
      await this.sleep(this.cooldownMs);
      if (this.stopped) return false;
    }

    await this.emit(interfaceId, RecoveryStage.TCP_CHECKING);
    if (!(await this.hooks.tcpCheck(interfaceId))) return false;

    if (runtime) {
      await this.emit(interfaceId, RecoveryStage.RPC_CHECKING);
      if (!(await this.hooks.rpcCheck(interfaceId))) return false;

      await this.emit(interfaceId, RecoveryStage.WARMING_UP);
      await this.sleep(this.warmupMs);
      if (this.stopped) return false;

      await this.emit(interfaceId, RecoveryStage.STABILITY_CHECK);
      if (!(await this.hooks.rpcCheck(interfaceId))) return false;
    }

    await this.emit(interfaceId, RecoveryStage.RECONNECTING);
    await this.hooks.doReconnect(interfaceId);

    await this.emit(interfaceId, RecoveryStage.DATA_LOADING);
    await this.hooks.reloadData(interfaceId);

    return true;
  }

  /** Schedule (or reschedule) the heartbeat retry loop for an interface. */
  private scheduleHeartbeat(interfaceId: string): void {
    if (this.stopped) return;
    const existing = this.heartbeats.get(interfaceId);
    if (existing) this.clearTimer(existing);

    const handle = this.setTimer(() => {
      this.heartbeats.delete(interfaceId);
      if (this.stopped) return;
      void this.recover(interfaceId).then((ok) => {
        if (!ok && !this.stopped) this.scheduleHeartbeat(interfaceId);
      });
    }, this.heartbeatMs);
    this.heartbeats.set(interfaceId, handle);
  }

  private async emit(interfaceId: string, stage: RecoveryStage): Promise<void> {
    await this.eventBus.publish({ type: 'recoveryStageChanged', interfaceId, stage });
  }

  /** Acquire a semaphore slot, waiting if the concurrency cap is reached. */
  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active++;
  }

  /** Release a semaphore slot, waking the next waiter if any. */
  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
