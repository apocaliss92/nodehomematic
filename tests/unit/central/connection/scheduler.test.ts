import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../../../src/central/connection/scheduler.js';

describe('central/connection/Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a job at its interval', async () => {
    const s = new Scheduler();
    const run = vi.fn();
    s.add({ name: 'tick', intervalMs: 1000, run });
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
    s.stop();
  });

  it('pauseAllExcept keeps only the named job running', async () => {
    const s = new Scheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.add({ name: 'a', intervalMs: 1000, run: a });
    s.add({ name: 'b', intervalMs: 1000, run: b });
    s.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    s.pauseAllExcept('a');
    await vi.advanceTimersByTimeAsync(2000);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('resume restarts the paused jobs', async () => {
    const s = new Scheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.add({ name: 'a', intervalMs: 1000, run: a });
    s.add({ name: 'b', intervalMs: 1000, run: b });
    s.start();
    s.pauseAllExcept('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(b).toHaveBeenCalledTimes(0);

    s.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('a throwing job does not stop the scheduler and is logged', async () => {
    const logger = { error: vi.fn() };
    const s = new Scheduler({ logger });
    const good = vi.fn();
    s.add({
      name: 'bad',
      intervalMs: 1000,
      run: () => {
        throw new Error('boom');
      },
    });
    s.add({ name: 'good', intervalMs: 1000, run: good });
    s.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(good).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    s.stop();
  });

  it('catches rejected async jobs without crashing the loop', async () => {
    const logger = { error: vi.fn() };
    const s = new Scheduler({ logger });
    s.add({
      name: 'asyncBad',
      intervalMs: 1000,
      run: async () => {
        await Promise.resolve();
        throw new Error('async boom');
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(logger.error).toHaveBeenCalled();
    s.stop();
  });

  it('stop clears all intervals', async () => {
    const s = new Scheduler();
    const run = vi.fn();
    s.add({ name: 'tick', intervalMs: 1000, run });
    s.start();
    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
