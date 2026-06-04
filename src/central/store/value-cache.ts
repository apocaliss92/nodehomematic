/**
 * Dynamic in-memory value cache.
 *
 * Holds the latest value received for each data point, keyed by the dpk's
 * stable `unique_id`. Staleness is computed against an injected clock so the
 * scheduler and tests stay deterministic; the default freshness window is 10s
 * (the production `MAX_CACHE_AGE`). This cache is volatile and never persisted.
 */

import { dpkToUniqueId, type DataPointKey } from '../../support/dpk.js';

/** Default freshness window in milliseconds (production `MAX_CACHE_AGE`). */
export const DEFAULT_MAX_CACHE_AGE_MS = 10_000;

/** A cached value together with the time it was recorded. */
export interface CachedValue {
  readonly value: unknown;
  /** Epoch/monotonic millis when the value was recorded. */
  readonly at: number;
}

/** In-memory latest-value store keyed by dpk unique id. */
export class ValueCache {
  private readonly store = new Map<string, CachedValue>();

  /** Record a value for a data point at time `at`. */
  public add(dpk: DataPointKey, value: unknown, at: number): void {
    this.store.set(dpkToUniqueId(dpk), { value, at });
  }

  /** Return the cached value for a data point, or `undefined` if absent. */
  public get(dpk: DataPointKey): CachedValue | undefined {
    return this.store.get(dpkToUniqueId(dpk));
  }

  /**
   * True if the entry is missing or older than `maxAgeMs` relative to `now`.
   * Unknown entries are always considered stale.
   */
  public isStale(
    dpk: DataPointKey,
    maxAgeMs: number = DEFAULT_MAX_CACHE_AGE_MS,
    now: number = Date.now(),
  ): boolean {
    const entry = this.store.get(dpkToUniqueId(dpk));
    if (entry === undefined) return true;
    return now - entry.at > maxAgeMs;
  }

  /** Remove all cached values. */
  public clear(): void {
    this.store.clear();
  }

  /** Iterate `[uniqueId, CachedValue]` pairs. */
  public entries(): IterableIterator<readonly [string, CachedValue]> {
    return this.store.entries();
  }
}
