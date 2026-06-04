import { describe, it, expect } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
} from '../../../../src/transport/resilience/circuit-breaker.js';

/** A controllable clock for deterministic time advancement. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

describe('CircuitBreaker', () => {
  it('starts in CLOSED and is available', () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.isAvailable()).toBe(true);
  });

  it('5 consecutive failures open the breaker', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
    expect(cb.isAvailable()).toBe(false);
  });

  it('does not open before failureThreshold', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.isAvailable()).toBe(true);
  });

  it('a success in CLOSED resets the failure counter', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.CLOSED);
  });

  it('after recoveryTimeout (30s) moves to HALF_OPEN and becomes available', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.isAvailable()).toBe(false);
    clock.advance(29999);
    expect(cb.isAvailable()).toBe(false);
    expect(cb.state).toBe(CircuitState.OPEN);
    clock.advance(1);
    expect(cb.isAvailable()).toBe(true);
    expect(cb.state).toBe(CircuitState.HALF_OPEN);
  });

  it('2 successes in HALF_OPEN re-close the breaker', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 5; i++) cb.recordFailure();
    clock.advance(30000);
    cb.isAvailable();
    expect(cb.state).toBe(CircuitState.HALF_OPEN);
    cb.recordSuccess();
    expect(cb.state).toBe(CircuitState.HALF_OPEN);
    cb.recordSuccess();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.isAvailable()).toBe(true);
  });

  it('a failure in HALF_OPEN immediately reopens the breaker', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ now: clock.now });
    for (let i = 0; i < 5; i++) cb.recordFailure();
    clock.advance(30000);
    cb.isAvailable();
    expect(cb.state).toBe(CircuitState.HALF_OPEN);
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
    expect(cb.isAvailable()).toBe(false);
    clock.advance(30000);
    expect(cb.isAvailable()).toBe(true);
  });

  it('recordRejection is a hook that does not alter the state', () => {
    const cb = new CircuitBreaker();
    cb.recordRejection();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(() => cb.recordRejection()).not.toThrow();
  });

  it('respects custom thresholds', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.CLOSED);
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
  });
});
