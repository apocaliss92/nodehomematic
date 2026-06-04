/**
 * Priority command throttle. With `intervalMs=0` (the default) it is a no-op
 * pass-through. With `intervalMs>0` it serialises queued commands, spacing them
 * by `intervalMs`, draining higher-priority commands first. CRITICAL commands
 * always bypass the queue. During a detected burst (more than `burstThreshold`
 * runs within `burstWindowMs`) HIGH commands are downgraded to LOW.
 */

/** Command priority; lower ordinal = served first. */
export enum CommandPriority {
  CRITICAL = 0,
  HIGH = 1,
  LOW = 2,
}

/** Tunables for {@link CommandThrottle}. */
export interface CommandThrottleConfig {
  /** Minimum spacing between dequeued commands, in ms. 0 disables throttling. */
  readonly intervalMs?: number;
  /** Runs within `burstWindowMs` above which HIGH is downgraded to LOW. */
  readonly burstThreshold?: number;
  /** Sliding window (ms) used for burst detection. */
  readonly burstWindowMs?: number;
  /** Injectable clock (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Injectable delay (defaults to a setTimeout-based promise). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  intervalMs: 0,
  burstThreshold: 5,
  burstWindowMs: 500,
} as const;

interface QueueItem {
  readonly priority: CommandPriority;
  readonly run: () => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class CommandThrottle {
  private readonly intervalMs: number;
  private readonly burstThreshold: number;
  private readonly burstWindowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly queue: QueueItem[] = [];
  private draining = false;
  private recentRuns: number[] = [];

  public constructor(config: CommandThrottleConfig = {}) {
    this.intervalMs = config.intervalMs ?? DEFAULTS.intervalMs;
    this.burstThreshold = config.burstThreshold ?? DEFAULTS.burstThreshold;
    this.burstWindowMs = config.burstWindowMs ?? DEFAULTS.burstWindowMs;
    this.now = config.now ?? ((): number => Date.now());
    this.sleep = config.sleep ?? defaultSleep;
  }

  /**
   * Run `fn` under the throttle. CRITICAL commands and a zero interval both
   * bypass the queue and execute immediately.
   */
  public run<T>(
    fn: () => Promise<T>,
    priority: CommandPriority = CommandPriority.HIGH,
  ): Promise<T> {
    if (this.intervalMs <= 0 || priority === CommandPriority.CRITICAL) {
      return fn();
    }

    const effectivePriority = this.resolvePriority(priority);
    return new Promise<T>((resolve, reject) => {
      this.enqueue({
        priority: effectivePriority,
        run: () => {
          fn().then(resolve, reject);
        },
      });
      // Defer draining to a microtask so all commands enqueued synchronously in
      // the same tick are ordered by priority before the queue starts draining.
      queueMicrotask(() => {
        void this.drain();
      });
    });
  }

  /** During a burst, HIGH is downgraded to LOW; other priorities are unchanged. */
  private resolvePriority(priority: CommandPriority): CommandPriority {
    if (priority === CommandPriority.HIGH && this.inBurst()) {
      return CommandPriority.LOW;
    }
    return priority;
  }

  private inBurst(): boolean {
    const cutoff = this.now() - this.burstWindowMs;
    this.recentRuns = this.recentRuns.filter((t) => t >= cutoff);
    return this.recentRuns.length > this.burstThreshold;
  }

  /** Insert keeping the queue ordered by ascending priority ordinal (stable). */
  private enqueue(item: QueueItem): void {
    let index = this.queue.length;
    for (let i = 0; i < this.queue.length; i += 1) {
      if (this.queue[i]!.priority > item.priority) {
        index = i;
        break;
      }
    }
    this.queue.splice(index, 0, item);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let first = true;
      while (this.queue.length > 0) {
        if (!first) {
          await this.sleep(this.intervalMs);
        }
        first = false;
        const item = this.queue.shift();
        if (!item) break;
        this.recentRuns.push(this.now());
        item.run();
      }
    } finally {
      this.draining = false;
    }
  }
}
