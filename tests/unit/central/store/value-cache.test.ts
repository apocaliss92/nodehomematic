import { describe, it, expect } from 'vitest';
import { ValueCache } from '../../../../src/central/store/value-cache.js';
import { makeDpk } from '../../../../src/support/dpk.js';

const dpk = makeDpk('iface-1', 'VCU1:1', 'VALUES', 'STATE');

describe('central/store/ValueCache', () => {
  it('add then get returns the stored value and timestamp', () => {
    const cache = new ValueCache();
    cache.add(dpk, true, 1000);
    expect(cache.get(dpk)).toEqual({ value: true, at: 1000 });
  });

  it('get returns undefined for unknown dpk', () => {
    const cache = new ValueCache();
    expect(cache.get(dpk)).toBeUndefined();
  });

  it('add overwrites by uniqueId regardless of dpk object identity', () => {
    const cache = new ValueCache();
    cache.add(dpk, 1, 100);
    cache.add(makeDpk('iface-1', 'VCU1:1', 'VALUES', 'STATE'), 2, 200);
    expect(cache.get(dpk)).toEqual({ value: 2, at: 200 });
  });

  it('isStale uses injected now and default max age 10s', () => {
    const cache = new ValueCache();
    cache.add(dpk, true, 1000);
    expect(cache.isStale(dpk, undefined, 1000 + 9999)).toBe(false);
    expect(cache.isStale(dpk, undefined, 1000 + 10001)).toBe(true);
  });

  it('isStale honours a custom max age', () => {
    const cache = new ValueCache();
    cache.add(dpk, true, 0);
    expect(cache.isStale(dpk, 5000, 4000)).toBe(false);
    expect(cache.isStale(dpk, 5000, 6000)).toBe(true);
  });

  it('isStale returns true for unknown entries', () => {
    const cache = new ValueCache();
    expect(cache.isStale(dpk, 5000, 0)).toBe(true);
  });

  it('clear empties the cache', () => {
    const cache = new ValueCache();
    cache.add(dpk, true, 1);
    cache.clear();
    expect(cache.get(dpk)).toBeUndefined();
    expect([...cache.entries()]).toHaveLength(0);
  });

  it('entries iterates stored values', () => {
    const cache = new ValueCache();
    cache.add(dpk, 7, 5);
    const entries = [...cache.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[1]).toEqual({ value: 7, at: 5 });
  });
});
