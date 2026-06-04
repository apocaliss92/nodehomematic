import { describe, it, expect, vi } from 'vitest';
import { RequestCoalescer, makeKey } from '../../../../src/transport/resilience/coalescer.js';

/** A manually-resolvable deferred promise. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('makeKey', () => {
  it('composes method + args separated by :', () => {
    expect(makeKey('getParamset', ['VCU001', 1, 'VALUES'])).toBe('getParamset:VCU001:1:VALUES');
  });

  it('serializes objects with ordered keys', () => {
    const k1 = makeKey('putParamset', [{ b: 2, a: 1 }]);
    const k2 = makeKey('putParamset', [{ a: 1, b: 2 }]);
    expect(k1).toBe(k2);
  });

  it('handles nested arrays and null', () => {
    expect(makeKey('m', [[1, 2], null])).toContain('m:');
  });
});

describe('RequestCoalescer', () => {
  it('two concurrent calls with the same key invoke fn only once', async () => {
    const coalescer = new RequestCoalescer();
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);

    const p1 = coalescer.coalesce('k', fn);
    const p2 = coalescer.coalesce('k', fn);
    expect(fn).toHaveBeenCalledTimes(1);

    d.resolve('value');
    await expect(p1).resolves.toBe('value');
    await expect(p2).resolves.toBe('value');
  });

  it('after completion a new call re-runs fn', async () => {
    const coalescer = new RequestCoalescer();
    const fn = vi.fn().mockResolvedValue('v');

    await coalescer.coalesce('k', fn);
    await coalescer.coalesce('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates the rejection to all concurrent awaiters', async () => {
    const coalescer = new RequestCoalescer();
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const err = new Error('boom');

    const p1 = coalescer.coalesce('k', fn);
    const p2 = coalescer.coalesce('k', fn);
    d.reject(err);

    await expect(p1).rejects.toBe(err);
    await expect(p2).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('after a rejection the key is free again', async () => {
    const coalescer = new RequestCoalescer();
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');

    await expect(coalescer.coalesce('k', fn)).rejects.toThrow('x');
    await expect(coalescer.coalesce('k', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('different keys → separate calls', async () => {
    const coalescer = new RequestCoalescer();
    const fn = vi.fn().mockResolvedValue('v');
    await Promise.all([coalescer.coalesce('a', fn), coalescer.coalesce('b', fn)]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
