/**
 * A minimal, dependency-free, type-safe event emitter.
 *
 * Generic over an event map `TMap` (event name → payload type). Listeners are
 * stored in a `Map<key, Set<listener>>`, which gives O(1) add/remove and
 * preserves insertion order on iteration. A listener that throws is isolated:
 * its error is routed to the optional `onError` handler (or swallowed) so it
 * never prevents the remaining listeners from running.
 *
 * Void payloads: an event whose payload type is `void` (e.g. `ready`) is
 * emitted with no second argument — `emit('ready')` — thanks to the
 * variadic-rest signature that resolves to `[]` for `void` payloads.
 */

/** A listener for a payload of type `P`. */
type Listener<P> = (payload: P) => void;

/** Maps a payload type to the trailing args of `emit` (`[]` when `void`). */
type EmitArgs<P> = P extends void ? [] : [payload: P];

export class TypedEventEmitter<TMap extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof TMap, Set<Listener<unknown>>>();
  readonly #onError?: (error: unknown) => void;

  /**
   * @param onError Optional handler invoked when a listener throws. When
   * omitted, listener errors are swallowed.
   */
  public constructor(onError?: (error: unknown) => void) {
    if (onError !== undefined) {
      this.#onError = onError;
    }
  }

  /** Subscribe to `event`. Returns an unsubscribe function. */
  public on<K extends keyof TMap>(event: K, listener: Listener<TMap[K]>): () => void {
    const set = this.#listeners.get(event) ?? new Set<Listener<unknown>>();
    set.add(listener as Listener<unknown>);
    this.#listeners.set(event, set);
    return () => {
      this.off(event, listener);
    };
  }

  /**
   * Subscribe to `event` for a single delivery. Returns an unsubscribe function
   * that also cancels the pending one-shot before it fires.
   */
  public once<K extends keyof TMap>(event: K, listener: Listener<TMap[K]>): () => void {
    const wrapper: Listener<TMap[K]> = (payload) => {
      off();
      listener(payload);
    };
    const off = this.on(event, wrapper);
    return off;
  }

  /** Remove a previously-registered listener for `event`. */
  public off<K extends keyof TMap>(event: K, listener: Listener<TMap[K]>): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    set.delete(listener as Listener<unknown>);
    if (set.size === 0) {
      this.#listeners.delete(event);
    }
  }

  /**
   * Emit `event` to all its listeners. For void-payload events, call with no
   * payload argument: `emit('ready')`. A throwing listener is isolated and its
   * error routed to `onError` (or swallowed); remaining listeners still run.
   */
  public emit<K extends keyof TMap>(event: K, ...args: EmitArgs<TMap[K]>): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    const payload = args[0] as TMap[K];
    // Snapshot so once()-driven mutation during iteration is safe.
    for (const listener of [...set]) {
      try {
        (listener as Listener<TMap[K]>)(payload);
      } catch (error: unknown) {
        this.#onError?.(error);
      }
    }
  }
}
