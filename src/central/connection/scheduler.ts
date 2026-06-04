/**
 * Interval job scheduler.
 *
 * Runs registered jobs on their own `setInterval` cadence. During connection
 * trouble the central calls {@link Scheduler.pauseAllExcept} to suspend every
 * job but the connection-check, and {@link Scheduler.resume} to restart the
 * rest. A job whose `run` throws or rejects is caught and logged via the
 * injectable logger; it never tears down the loop. Uses real timers, so tests
 * drive it with `vi.useFakeTimers()`.
 */

/** A periodic job. */
export interface ScheduledJob {
  readonly name: string;
  readonly intervalMs: number;
  readonly run: () => Promise<void> | void;
}

/** Minimal logger contract used to report job failures. */
export interface SchedulerLogger {
  error(message: string, error: unknown): void;
}

/** Constructor options for {@link Scheduler}. */
export interface SchedulerOptions {
  readonly logger?: SchedulerLogger;
}

const NOOP_LOGGER: SchedulerLogger = {
  error: () => {
    /* no-op */
  },
};

export class Scheduler {
  private readonly logger: SchedulerLogger;
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private started = false;

  public constructor(options: SchedulerOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** Register a job (replacing any job with the same name). */
  public add(job: ScheduledJob): void {
    this.jobs.set(job.name, job);
    if (this.started) {
      this.arm(job);
    }
  }

  /** Start all registered jobs. */
  public start(): void {
    this.started = true;
    for (const job of this.jobs.values()) {
      this.arm(job);
    }
  }

  /** Stop and clear all interval timers. */
  public stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /** Suspend every job except the named one (keeps it running unchanged). */
  public pauseAllExcept(name: string): void {
    for (const [jobName, timer] of this.timers) {
      if (jobName !== name) {
        clearInterval(timer);
        this.timers.delete(jobName);
      }
    }
  }

  /** Restart any registered job that is not currently armed. */
  public resume(): void {
    if (!this.started) return;
    for (const job of this.jobs.values()) {
      if (!this.timers.has(job.name)) {
        this.arm(job);
      }
    }
  }

  /** Arm (or re-arm) the interval timer for a single job. */
  private arm(job: ScheduledJob): void {
    const existing = this.timers.get(job.name);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => {
      void this.invoke(job);
    }, job.intervalMs);
    this.timers.set(job.name, timer);
  }

  /** Invoke a job, catching and logging any sync throw or async rejection. */
  private async invoke(job: ScheduledJob): Promise<void> {
    try {
      await job.run();
    } catch (error: unknown) {
      this.logger.error(`Scheduled job "${job.name}" failed`, error);
    }
  }
}
