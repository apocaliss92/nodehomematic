/**
 * Typed in-process event bus for the central.
 *
 * Dispatch is by event CLASS (the `type` discriminant), not by a topic string.
 * A subscriber for type `T` receives only events of that type whose natural key
 * matches its `key` (or all of that type when no `key` is given — a wildcard).
 * Handlers are ordered by priority then insertion order and run concurrently
 * with error isolation: a throwing/rejecting handler is logged via the injected
 * logger and never prevents the other handlers from running, nor is it
 * rethrown to the publisher.
 */

import { eventKey, type CentralEvent, type CentralEventType } from './events.js';

/** Handler priority. Lower numeric value runs first. */
export enum EventPriority {
  CRITICAL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
}

/** Minimal logger contract used to report handler failures. */
export interface EventBusLogger {
  error(message: string, error: unknown): void;
}

/** Options accepted by {@link EventBus.subscribe}. */
export interface SubscribeOptions<T extends CentralEventType> {
  /** Event type discriminant to listen for. */
  readonly type: T;
  /** Optional natural routing key; omit for a wildcard over the whole type. */
  readonly key?: string;
  /** Handler invoked with the narrowed event payload. */
  readonly handler: (event: Extract<CentralEvent, { type: T }>) => void | Promise<void>;
  /** Priority; defaults to {@link EventPriority.NORMAL}. */
  readonly priority?: EventPriority;
}

/** Constructor options for {@link EventBus}. */
export interface EventBusOptions {
  /** Logger used to report handler failures; defaults to a no-op. */
  readonly logger?: EventBusLogger;
}

interface Subscription {
  readonly type: CentralEventType;
  readonly key: string | undefined;
  readonly handler: (event: CentralEvent) => void | Promise<void>;
  readonly priority: EventPriority;
  /** Monotonically increasing id used as a stable insertion-order tiebreak. */
  readonly seq: number;
}

const NOOP_LOGGER: EventBusLogger = {
  error: () => {
    /* no-op */
  },
};

export class EventBus {
  private readonly logger: EventBusLogger;
  private readonly subscriptions = new Set<Subscription>();
  private seq = 0;

  public constructor(options: EventBusOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** Number of active subscriptions. */
  public get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Subscribe to events of a given type (optionally filtered by key).
   * Returns an unsubscribe function.
   */
  public subscribe<T extends CentralEventType>(opts: SubscribeOptions<T>): () => void {
    const subscription: Subscription = {
      type: opts.type,
      key: opts.key,
      // The cast narrows the generic handler to the erased union shape; it is
      // sound because we only ever invoke it with an event of `opts.type`.
      handler: opts.handler as (event: CentralEvent) => void | Promise<void>,
      priority: opts.priority ?? EventPriority.NORMAL,
      seq: this.seq++,
    };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** Publish a single event to all matching handlers. */
  public async publish(event: CentralEvent): Promise<void> {
    const naturalKey = eventKey(event);
    const matching = [...this.subscriptions]
      .filter((sub) => sub.type === event.type && (sub.key === undefined || sub.key === naturalKey))
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq);

    if (matching.length === 0) return;

    const results = await Promise.allSettled(matching.map(async (sub) => sub.handler(event)));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result && result.status === 'rejected') {
        this.logger.error(`Event handler for "${event.type}" failed`, result.reason);
      }
    }
  }

  /** Publish a batch of events sequentially. */
  public async publishBatch(events: CentralEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  /** Remove all subscriptions. */
  public clear(): void {
    this.subscriptions.clear();
  }
}
