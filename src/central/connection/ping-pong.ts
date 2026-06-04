/**
 * Ping/pong loss detector.
 *
 * Before each XML-RPC `ping(callerId="{interfaceId}#{token}")` the central
 * records the token here ({@link PingPongTracker.handleSendPing}); when the CCU
 * echoes the token back as a PONG event the central reconciles it
 * ({@link PingPongTracker.handleReceivedPong}). A persistent excess of
 * unanswered pings (or unexpected pongs) indicates the callback channel is no
 * longer healthy, which the recovery logic treats as a loss signal.
 *
 * The clock is injectable so TTL pruning is deterministic in tests.
 */

/** Default mismatch threshold before {@link PingPongTracker.isMismatch}. */
export const DEFAULT_PING_PONG_MISMATCH_COUNT = 15;
/** Default TTL (ms) after which a pending ping / unknown pong is pruned. */
export const DEFAULT_PING_PONG_TTL_MS = 300_000;
/** Default retry window (ms) for reconciling an unexpected pong. */
export const DEFAULT_UNKNOWN_RETRY_MS = 15_000;
/** Default cap on the number of tracked entries per bucket. */
export const DEFAULT_MAX_SIZE = 100;

/** Constructor options for {@link PingPongTracker}. */
export interface PingPongTrackerOptions {
  /** Count above which {@link PingPongTracker.isMismatch} returns true. */
  readonly mismatchThreshold?: number;
  /** TTL (ms) after which stale entries are pruned. */
  readonly ttlMs?: number;
  /** Retry window (ms) used for unknown-pong reconciliation semantics. */
  readonly unknownRetryMs?: number;
  /** Maximum tracked entries per bucket (oldest dropped first). */
  readonly maxSize?: number;
  /** Injectable monotonic clock (defaults to `Date.now`). */
  readonly now?: () => number;
}

export class PingPongTracker {
  private readonly mismatchThreshold: number;
  private readonly ttlMs: number;
  private readonly unknownRetryMs: number;
  private readonly maxSize: number;
  private readonly now: () => number;

  /** token → time the ping was sent. */
  private readonly pending = new Map<string, number>();
  /** token → time the unexpected pong arrived. */
  private readonly unknown = new Map<string, number>();

  public constructor(options: PingPongTrackerOptions = {}) {
    this.mismatchThreshold = options.mismatchThreshold ?? DEFAULT_PING_PONG_MISMATCH_COUNT;
    this.ttlMs = options.ttlMs ?? DEFAULT_PING_PONG_TTL_MS;
    this.unknownRetryMs = options.unknownRetryMs ?? DEFAULT_UNKNOWN_RETRY_MS;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.now = options.now ?? Date.now;
  }

  /** Record that a ping carrying `token` was just sent. */
  public handleSendPing(token: string): void {
    // A late ping for a token we already saw as an unexpected pong reconciles
    // the two: drop the queued unknown rather than tracking a new pending ping.
    if (this.unknown.delete(token)) {
      return;
    }
    this.pending.set(token, this.now());
    this.enforceMaxSize(this.pending);
  }

  /** Record a received PONG carrying `token`. */
  public handleReceivedPong(token: string): void {
    // Matched a ping we were waiting for → reconciled.
    if (this.pending.delete(token)) {
      return;
    }
    // A pong we did not (yet) expect; queue it for later reconciliation.
    this.unknown.set(token, this.now());
    this.enforceMaxSize(this.unknown);
  }

  /** Number of pings still awaiting a pong (after lazy pruning). */
  public get pendingCount(): number {
    this.prune();
    return this.pending.size;
  }

  /** Number of unexpected pongs not yet reconciled (after lazy pruning). */
  public get unknownCount(): number {
    this.prune();
    return this.unknown.size;
  }

  /** True when either bucket exceeds the mismatch threshold. */
  public isMismatch(): boolean {
    return this.pendingCount > this.mismatchThreshold || this.unknownCount > this.mismatchThreshold;
  }

  /** Drop entries older than the TTL (and re-enforce the size caps). */
  public prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, at] of this.pending) {
      if (at < cutoff) this.pending.delete(token);
    }
    for (const [token, at] of this.unknown) {
      if (at < cutoff) this.unknown.delete(token);
    }
    this.enforceMaxSize(this.pending);
    this.enforceMaxSize(this.unknown);
  }

  /** Forget all tracked state. */
  public reset(): void {
    this.pending.clear();
    this.unknown.clear();
  }

  /** Drop the oldest insertion-order entries until the map fits `maxSize`. */
  private enforceMaxSize(map: Map<string, number>): void {
    while (map.size > this.maxSize) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
