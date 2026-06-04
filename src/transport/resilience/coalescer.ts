/**
 * Request coalescer: deduplicates concurrent identical async calls. The first
 * caller for a key registers a pending promise; concurrent callers with the
 * same key share it. The entry is removed once the promise settles (resolve or
 * reject), so a later call re-runs `fn`. There is no TTL.
 */

/** Build a stable coalescing key from a method name and its positional args. */
export function makeKey(method: string, args: readonly unknown[]): string {
  return method + ':' + args.map(stringifyArg).join(':');
}

/** Stringify a single arg; objects use deterministic, sorted-key JSON. */
function stringifyArg(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return value.toString();
    default:
      // object, function, symbol → deterministic JSON.
      return stableStringify(value);
  }
}

/** JSON stringify with object keys sorted recursively for stability. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const members = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]));
  return '{' + members.join(',') + '}';
}

export class RequestCoalescer {
  private readonly pending = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` under `key`, sharing an in-flight promise with concurrent callers
   * of the same key. Errors propagate to all awaiters.
   */
  public coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = fn().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  /** Number of in-flight coalesced requests (observability/testing). */
  public get size(): number {
    return this.pending.size;
  }
}
