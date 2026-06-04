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
  it('parte in CLOSED ed è disponibile', () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.isAvailable()).toBe(true);
  });

  it('5 failure consecutive aprono il breaker', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
    expect(cb.isAvailable()).toBe(false);
  });

  it('non apre prima di failureThreshold', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(cb.isAvailable()).toBe(true);
  });

  it('un successo in CLOSED azzera il contatore failure', () => {
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

  it('dopo recoveryTimeout (30s) passa a HALF_OPEN e diventa disponibile', () => {
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

  it('2 successi in HALF_OPEN richiudono il breaker', () => {
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

  it('una failure in HALF_OPEN riapre subito il breaker', () => {
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

  it('recordRejection è un hook che non altera lo stato', () => {
    const cb = new CircuitBreaker();
    cb.recordRejection();
    expect(cb.state).toBe(CircuitState.CLOSED);
    expect(() => cb.recordRejection()).not.toThrow();
  });

  it('rispetta soglie custom', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.CLOSED);
    cb.recordFailure();
    expect(cb.state).toBe(CircuitState.OPEN);
  });
});
