import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandThrottle, CommandPriority } from '../../../../src/transport/resilience/throttle.js';

describe('CommandThrottle', () => {
  it('con intervalMs=0 (default) esegue fn immediatamente', async () => {
    const throttle = new CommandThrottle();
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(throttle.run(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('con intervalMs=0 più comandi passano subito', async () => {
    const throttle = new CommandThrottle();
    const results = await Promise.all([
      throttle.run(() => Promise.resolve(1)),
      throttle.run(() => Promise.resolve(2)),
      throttle.run(() => Promise.resolve(3)),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('propaga gli errori di fn', async () => {
    const throttle = new CommandThrottle();
    const err = new Error('nope');
    await expect(throttle.run(() => Promise.reject(err))).rejects.toBe(err);
  });

  describe('con intervalMs>0 e timer fake', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('CRITICAL bypassa il throttle ed esegue subito', async () => {
      const throttle = new CommandThrottle({ intervalMs: 1000 });
      const fn = vi.fn().mockResolvedValue('crit');
      const p = throttle.run(fn, CommandPriority.CRITICAL);
      await expect(p).resolves.toBe('crit');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('esegue i comandi in coda rispettando lordine di priorità', async () => {
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

      // HIGH deve precedere LOW nella coda a priorità.
      expect(order).toEqual(['high', 'low']);
    });

    it('serializza i comandi separandoli di intervalMs', async () => {
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
