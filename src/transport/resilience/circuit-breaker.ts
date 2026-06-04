/**
 * Circuit breaker guarding outbound CCU calls. Mirrors aiohomematic's breaker
 * semantics: CLOSED → OPEN after `failureThreshold` consecutive failures; OPEN
 * → HALF_OPEN once `recoveryTimeoutMs` has elapsed; HALF_OPEN → CLOSED after
 * `successThreshold` successes, or back to OPEN on any failure.
 *
 * The breaker only tracks state; deciding whether a given method bypasses it
 * (init/ping/getVersion/Session.*) is the caller's responsibility.
 */

/** Lifecycle states of the breaker. */
export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/** Tunables for {@link CircuitBreaker}. */
export interface CircuitBreakerConfig {
  /** Consecutive failures in CLOSED that trip the breaker open. */
  readonly failureThreshold?: number;
  /** Milliseconds the breaker stays OPEN before probing (HALF_OPEN). */
  readonly recoveryTimeoutMs?: number;
  /** Successes in HALF_OPEN required to close the breaker. */
  readonly successThreshold?: number;
  /** Injectable clock (defaults to `Date.now`). */
  readonly now?: () => number;
}

const DEFAULTS = {
  failureThreshold: 5,
  recoveryTimeoutMs: 30000,
  successThreshold: 2,
} as const;

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly now: () => number;

  private currentState: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private openedAt = 0;
  private rejectionCount = 0;

  public constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? DEFAULTS.failureThreshold;
    this.recoveryTimeoutMs = config.recoveryTimeoutMs ?? DEFAULTS.recoveryTimeoutMs;
    this.successThreshold = config.successThreshold ?? DEFAULTS.successThreshold;
    this.now = config.now ?? ((): number => Date.now());
  }

  /** Current breaker state. */
  public get state(): CircuitState {
    return this.currentState;
  }

  /**
   * Whether a protected call may proceed. Has a side effect: an OPEN breaker
   * whose recovery window has elapsed transitions to HALF_OPEN here.
   */
  public isAvailable(): boolean {
    if (this.currentState === CircuitState.OPEN) {
      if (this.now() - this.openedAt >= this.recoveryTimeoutMs) {
        this.toHalfOpen();
        return true;
      }
      return false;
    }
    // CLOSED and HALF_OPEN both permit calls.
    return true;
  }

  /** Record a successful protected call. */
  public recordSuccess(): void {
    if (this.currentState === CircuitState.HALF_OPEN) {
      this.successCount += 1;
      if (this.successCount >= this.successThreshold) {
        this.toClosed();
      }
      return;
    }
    // A success in CLOSED clears any accumulated failures.
    this.failureCount = 0;
  }

  /** Record a failed protected call. */
  public recordFailure(): void {
    if (this.currentState === CircuitState.HALF_OPEN) {
      this.toOpen();
      return;
    }
    if (this.currentState === CircuitState.CLOSED) {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) {
        this.toOpen();
      }
    }
  }

  /**
   * Hook invoked when a non-bypass call was rejected because the breaker was
   * unavailable. Kept minimal (a counter) for observability.
   */
  public recordRejection(): void {
    this.rejectionCount += 1;
  }

  /** Number of rejected calls (observability only). */
  public get rejections(): number {
    return this.rejectionCount;
  }

  private toOpen(): void {
    this.currentState = CircuitState.OPEN;
    this.openedAt = this.now();
    this.failureCount = 0;
    this.successCount = 0;
  }

  private toHalfOpen(): void {
    this.currentState = CircuitState.HALF_OPEN;
    this.successCount = 0;
    this.failureCount = 0;
  }

  private toClosed(): void {
    this.currentState = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
  }
}
