/**
 * Connection lifecycle state machine for an interface client. Validates
 * transitions against the protocol table, notifies subscribers on change, and
 * computes the exponential reconnect backoff delay.
 */

import { InvalidStateTransitionError } from '../../support/errors.js';

/** Lifecycle states of an interface client connection. */
export enum ClientState {
  CREATED = 'CREATED',
  INITIALIZING = 'INITIALIZING',
  INITIALIZED = 'INITIALIZED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  RECONNECTING = 'RECONNECTING',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED',
  FAILED = 'FAILED',
}

/** Allowed target states for each source state (protocol transition table). */
export const VALID_TRANSITIONS: Readonly<Record<ClientState, readonly ClientState[]>> = {
  [ClientState.CREATED]: [ClientState.INITIALIZING],
  [ClientState.INITIALIZING]: [ClientState.INITIALIZED, ClientState.FAILED],
  [ClientState.INITIALIZED]: [ClientState.CONNECTING, ClientState.DISCONNECTED],
  [ClientState.CONNECTING]: [ClientState.CONNECTED, ClientState.FAILED],
  [ClientState.CONNECTED]: [
    ClientState.DISCONNECTED,
    ClientState.RECONNECTING,
    ClientState.STOPPING,
  ],
  [ClientState.DISCONNECTED]: [
    ClientState.CONNECTING,
    ClientState.DISCONNECTED,
    ClientState.RECONNECTING,
    ClientState.STOPPING,
  ],
  [ClientState.RECONNECTING]: [
    ClientState.CONNECTED,
    ClientState.DISCONNECTED,
    ClientState.FAILED,
    ClientState.CONNECTING,
  ],
  [ClientState.STOPPING]: [ClientState.STOPPED],
  [ClientState.STOPPED]: [],
  [ClientState.FAILED]: [
    ClientState.INITIALIZING,
    ClientState.CONNECTING,
    ClientState.RECONNECTING,
    ClientState.DISCONNECTED,
  ],
};

/** Payload delivered to {@link ConnectionStateMachine.onChange} subscribers. */
export interface StateChangeEvent {
  readonly from: ClientState;
  readonly to: ClientState;
  readonly reason?: string;
}

type ChangeListener = (event: StateChangeEvent) => void;

/** Reconnect backoff tunables. */
const RECONNECT = {
  initialDelayMs: 2000,
  backoffFactor: 2,
  maxDelayMs: 120000,
} as const;

export class ConnectionStateMachine {
  private currentState: ClientState;
  private failure: string | undefined;
  private readonly listeners = new Set<ChangeListener>();

  public constructor(initial: ClientState = ClientState.CREATED) {
    this.currentState = initial;
  }

  /** Current state. */
  public get state(): ClientState {
    return this.currentState;
  }

  /** Reason recorded when the machine last entered FAILED, if any. */
  public get failureReason(): string | undefined {
    return this.failure;
  }

  /**
   * Transition to `target`. Throws {@link InvalidStateTransitionError} if the
   * transition is not permitted, leaving the current state untouched.
   */
  public transitionTo(target: ClientState, reason?: string): void {
    const allowed = VALID_TRANSITIONS[this.currentState];
    if (!allowed.includes(target)) {
      throw new InvalidStateTransitionError(
        `Invalid transition ${this.currentState} → ${target}${reason ? ` (${reason})` : ''}`,
      );
    }
    const from = this.currentState;
    this.currentState = target;
    if (target === ClientState.FAILED) {
      this.failure = reason;
    }
    const event: StateChangeEvent =
      reason === undefined ? { from, to: target } : { from, to: target, reason };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
  public onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Reconnect backoff for a given (zero-based) attempt:
   * `min(initialDelay * factor^attempt, maxDelay)`.
   */
  public reconnectDelay(attempt: number): number {
    const delay = RECONNECT.initialDelayMs * Math.pow(RECONNECT.backoffFactor, attempt);
    return Math.min(delay, RECONNECT.maxDelayMs);
  }
}
