import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandThrottle, CommandPriority } from '../../../../src/transport/resilience/throttle.js';

describe('CommandThrottle', () => {
  it('with intervalMs=0 (default) runs fn immediately', async () => {
    const throttle = new CommandThrottle();
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(throttle.run(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('with intervalMs=0 multiple commands pass through immediately', async () => {
    const throttle = new CommandThrottle();
    const results = await Promise.all([
      throttle.run(() => Promise.resolve(1)),
      throttle.run(() => Promise.resolve(2)),
      throttle.run(() => Promise.resolve(3)),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('propagates fn errors', async () => {
    const throttle = new CommandThrottle();
    const err = new Error('nope');
    await expect(throttle.run(() => Promise.reject(err))).rejects.toBe(err);
  });

  describe('with intervalMs>0 and fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('CRITICAL bypasses the throttle and runs immediately', async () => {
      const throttle = new CommandThrottle({ intervalMs: 1000 });
      const fn = vi.fn().mockResolvedValue('crit');
      const p = throttle.run(fn, CommandPriority.CRITICAL);
      await expect(p).resolves.toBe('crit');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('runs the queued commands respecting the priority order', async () => {
      const throttle = new CommandThrottle({ intervalMs: 100 });
      const order: string[] = [];
      const lowP = throttle.run(async () => {
        order.push('low');
      }, CommandPriority.LOW);
      const highP = throttle.run(async () => {
        order.push('high');
      }, CommandPriority.HIGH);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([lowP, highP]);

      // HIGH must precede LOW in the priority queue.
      expect(order).toEqual(['high', 'low']);
    });

    it('serializes the commands spacing them by intervalMs', async () => {
      const throttle = new CommandThrottle({ intervalMs: 100 });
      const fn = vi.fn().mockResolvedValue(undefined);
      const p1 = throttle.run(fn);
      const p2 = throttle.run(fn);

      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([p1, p2]);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
