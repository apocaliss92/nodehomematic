/**
 * Per-interface connection state, issue flags and callback liveness.
 *
 * Tracks the {@link ClientState} of each interface, a set of qualitative issue
 * flags (e.g. JSON-RPC down, XML-RPC down, callback silent) and the time of the
 * last inbound event. State changes are published on an optional {@link EventBus}
 * as `connectionStateChanged`. The clock is injectable for deterministic tests.
 */

import { ClientState } from '../../transport/resilience/state-machine.js';
import type { EventBus } from '../event-bus.js';

/** Qualitative connection problem categories. */
export type ConnectionIssue = 'json' | 'rpc' | 'callback';

/** Default callback-silence window (ms) before liveness is considered lost. */
export const DEFAULT_CALLBACK_WARN_INTERVAL_MS = 180_000;

/** Constructor options for {@link ConnectionStateTracker}. */
export interface ConnectionStateTrackerOptions {
  /** Bus to publish `connectionStateChanged` on; omit to skip publishing. */
  readonly eventBus?: EventBus;
  /** Injectable monotonic clock (defaults to `Date.now`). */
  readonly now?: () => number;
}

export class ConnectionStateTracker {
  private readonly eventBus: EventBus | undefined;
  private readonly now: () => number;

  private readonly states = new Map<string, ClientState>();
  private readonly issues = new Map<string, Set<ConnectionIssue>>();
  private readonly lastEventAt = new Map<string, number>();

  public constructor(options: ConnectionStateTrackerOptions = {}) {
    this.eventBus = options.eventBus;
    this.now = options.now ?? Date.now;
  }

  /** Set the state for an interface and publish `connectionStateChanged`. */
  public setState(interfaceId: string, state: ClientState, reason?: string): void {
    this.states.set(interfaceId, state);
    if (this.eventBus) {
      void this.eventBus.publish(
        reason === undefined
          ? { type: 'connectionStateChanged', interfaceId, state }
          : { type: 'connectionStateChanged', interfaceId, state, reason },
      );
    }
  }

  /** Current state for an interface (defaults to {@link ClientState.CREATED}). */
  public getState(interfaceId: string): ClientState {
    return this.states.get(interfaceId) ?? ClientState.CREATED;
  }

  /** Flag an issue on an interface. */
  public addIssue(interfaceId: string, kind: ConnectionIssue): void {
    const set = this.issues.get(interfaceId) ?? new Set<ConnectionIssue>();
    set.add(kind);
    this.issues.set(interfaceId, set);
  }

  /** Clear a single issue flag on an interface. */
  public removeIssue(interfaceId: string, kind: ConnectionIssue): void {
    this.issues.get(interfaceId)?.delete(kind);
  }

  /**
   * True if the interface has the given issue, or (when `kind` is omitted) any
   * issue at all.
   */
  public hasIssue(interfaceId: string, kind?: ConnectionIssue): boolean {
    const set = this.issues.get(interfaceId);
    if (!set) return false;
    return kind === undefined ? set.size > 0 : set.has(kind);
  }

  /** Clear all issue flags on an interface. */
  public clearIssues(interfaceId: string): void {
    this.issues.delete(interfaceId);
  }

  /** Record the time of the latest inbound event for an interface. */
  public recordEvent(interfaceId: string, at: number = this.now()): void {
    this.lastEventAt.set(interfaceId, at);
  }

  /**
   * True if the callback channel is considered alive: either no event has been
   * recorded yet (we have no evidence of silence) or the elapsed time since the
   * last event is within the warn interval.
   */
  public isCallbackAlive(
    interfaceId: string,
    warnIntervalMs: number = DEFAULT_CALLBACK_WARN_INTERVAL_MS,
    now: number = this.now(),
  ): boolean {
    const last = this.lastEventAt.get(interfaceId);
    if (last === undefined) return true;
    return now - last <= warnIntervalMs;
  }
}
