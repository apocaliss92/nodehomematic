import { describe, it, expect, vi } from 'vitest';
import { withRetry, defaultGetFaultCode } from '../../../../src/transport/resilience/retry.js';
import {
  AuthFailureError,
  CircuitBreakerOpenError,
  CommandSupersededError,
  UnsupportedError,
  ValidationError,
  TimeoutError,
  NoConnectionError,
  InternalBackendError,
} from '../../../../src/support/errors.js';

/** A sleep recorder that resolves immediately and records requested delays. */
function sleepRecorder(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe('withRetry', () => {
  it('resolves immediately when fn succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const { sleep, delays } = sleepRecorder();
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it('retries a retryable error and resolves on the 2nd attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TimeoutError('boom')).mockResolvedValue('ok');
    const { sleep, delays } = sleepRecorder();
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(1);
  });

  it('persistent retryable error: tries maxAttempts times then rethrows', async () => {
    const err = new NoConnectionError('down');
    const fn = vi.fn().mockRejectedValue(err);
    const { sleep, delays } = sleepRecorder();
    await expect(withRetry(fn, { maxAttempts: 3, sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
  });

  it.each([
    new AuthFailureError(),
    new CircuitBreakerOpenError(),
    new CommandSupersededError(),
    new UnsupportedError(),
    new ValidationError(),
  ])('non-retryable error rethrown after a single attempt', async (err) => {
    const fn = vi.fn().mockRejectedValue(err);
    const { sleep, delays } = sleepRecorder();
    await expect(withRetry(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it('InternalBackendError is retryable', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new InternalBackendError()).mockResolvedValue(42);
    const { sleep } = sleepRecorder();
    await expect(withRetry(fn, { sleep })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fault -8 (dutyCycle) requires a ~40s delay', async () => {
    const err = Object.assign(new Error('duty'), { faultCode: -8 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const { sleep, delays } = sleepRecorder();
    await withRetry(fn, { sleep, dutyCycleDelayMs: 40000 });
    expect(delays).toEqual([40000]);
  });

  it('fault -10 (transmission pending) requires a ~5s delay', async () => {
    const err = Object.assign(new Error('pending'), { faultCode: -10 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const { sleep, delays } = sleepRecorder();
    await withRetry(fn, { sleep, transmissionPendingDelayMs: 5000 });
    expect(delays).toEqual([5000]);
  });

  it('generic fault -1 is retryable with exponential backoff (no jitter)', async () => {
    const err = Object.assign(new Error('generic'), { faultCode: -1 });
    const fn = vi.fn().mockRejectedValue(err);
    const { sleep, delays } = sleepRecorder();
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 2000,
        backoffFactor: 2,
        jitter: 0,
        sleep,
      }),
    ).rejects.toBe(err);
    expect(delays).toEqual([2000, 4000]);
  });

  it('respects maxDelayMs in the backoff', async () => {
    const err = new TimeoutError();
    const fn = vi.fn().mockRejectedValue(err);
    const { sleep, delays } = sleepRecorder();
    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 10000,
        backoffFactor: 2,
        maxDelayMs: 15000,
        jitter: 0,
        sleep,
      }),
    ).rejects.toBe(err);
    expect(delays).toEqual([10000, 15000, 15000]);
  });

  it('jitter applies a deterministic multiplier via the injected random', async () => {
    const err = new TimeoutError();
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const { sleep, delays } = sleepRecorder();
    // random=1 → multiplier (1 - jitter + 2*jitter*1) = 1 + jitter
    await withRetry(fn, {
      baseDelayMs: 1000,
      jitter: 0.2,
      random: () => 1,
      sleep,
    });
    expect(delays[0]).toBeCloseTo(1200, 5);
  });

  it('maxAttempts<=0 disables retries (a single call)', async () => {
    const err = new TimeoutError();
    const fn = vi.fn().mockRejectedValue(err);
    const { sleep, delays } = sleepRecorder();
    await expect(withRetry(fn, { maxAttempts: 0, sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it('a custom isRetryable overrides the default classification', async () => {
    const err = new Error('weird');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const { sleep } = sleepRecorder();
    await expect(withRetry(fn, { sleep, isRetryable: () => true })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('an unknown error is not retryable by default', async () => {
    const err = new Error('mystery');
    const fn = vi.fn().mockRejectedValue(err);
    const { sleep } = sleepRecorder();
    await expect(withRetry(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  describe('defaultGetFaultCode', () => {
    it('reads a direct faultCode', () => {
      expect(defaultGetFaultCode(Object.assign(new Error(), { faultCode: -8 }))).toBe(-8);
    });

    it('walks the cause chain', () => {
      const cause = Object.assign(new Error(), { faultCode: -10 });
      const err = Object.assign(new Error(), { cause });
      expect(defaultGetFaultCode(err)).toBe(-10);
    });

    it('returns undefined when no numeric faultCode is found', () => {
      expect(defaultGetFaultCode(new Error('x'))).toBeUndefined();
      expect(defaultGetFaultCode('not an error')).toBeUndefined();
    });
  });
});
