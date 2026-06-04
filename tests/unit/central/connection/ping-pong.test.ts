import { describe, it, expect } from 'vitest';
import { PingPongTracker } from '../../../../src/central/connection/ping-pong.js';

describe('central/connection/PingPongTracker', () => {
  it('sending N pings then receiving their pongs reconciles to pendingCount 0', () => {
    const t = new PingPongTracker();
    for (let i = 0; i < 5; i++) t.handleSendPing(`tok-${i}`);
    expect(t.pendingCount).toBe(5);
    for (let i = 0; i < 5; i++) t.handleReceivedPong(`tok-${i}`);
    expect(t.pendingCount).toBe(0);
    expect(t.unknownCount).toBe(0);
    expect(t.isMismatch()).toBe(false);
  });

  it('pending exceeding the mismatch threshold flips isMismatch true', () => {
    const t = new PingPongTracker({ mismatchThreshold: 3 });
    for (let i = 0; i < 3; i++) t.handleSendPing(`p-${i}`);
    expect(t.isMismatch()).toBe(false);
    t.handleSendPing('p-3');
    expect(t.pendingCount).toBe(4);
    expect(t.isMismatch()).toBe(true);
  });

  it('unknown pongs exceeding threshold also flip isMismatch true', () => {
    const t = new PingPongTracker({ mismatchThreshold: 2 });
    t.handleReceivedPong('u1');
    t.handleReceivedPong('u2');
    expect(t.isMismatch()).toBe(false);
    t.handleReceivedPong('u3');
    expect(t.unknownCount).toBe(3);
    expect(t.isMismatch()).toBe(true);
  });

  it('an unknown pong is reconciled when a matching ping arrives later', () => {
    const t = new PingPongTracker();
    t.handleReceivedPong('late');
    expect(t.unknownCount).toBe(1);
    t.handleSendPing('late');
    // The later ping cancels the queued unknown pong rather than re-queuing.
    expect(t.unknownCount).toBe(0);
    expect(t.pendingCount).toBe(0);
  });

  it('prune drops pending and unknown entries older than ttl by injected clock', () => {
    let now = 1000;
    const t = new PingPongTracker({ ttlMs: 5000, now: () => now });
    t.handleSendPing('old-ping');
    t.handleReceivedPong('old-unknown');
    now = 1000 + 5001;
    t.handleSendPing('fresh-ping');
    t.prune();
    expect(t.pendingCount).toBe(1);
    expect(t.unknownCount).toBe(0);
  });

  it('getters prune lazily so stale entries are not counted', () => {
    let now = 0;
    const t = new PingPongTracker({ ttlMs: 100, now: () => now });
    t.handleSendPing('a');
    t.handleReceivedPong('b');
    now = 200;
    expect(t.pendingCount).toBe(0);
    expect(t.unknownCount).toBe(0);
  });

  it('enforces maxSize by dropping the oldest entries', () => {
    let now = 0;
    const t = new PingPongTracker({ maxSize: 3, now: () => now });
    for (let i = 0; i < 5; i++) {
      now = i;
      t.handleSendPing(`k-${i}`);
    }
    expect(t.pendingCount).toBe(3);
  });

  it('reset clears all state', () => {
    const t = new PingPongTracker();
    t.handleSendPing('a');
    t.handleReceivedPong('b');
    t.reset();
    expect(t.pendingCount).toBe(0);
    expect(t.unknownCount).toBe(0);
  });
});
