import { describe, it, expect } from 'vitest';
import { ConnectionStateTracker } from '../../../../src/central/connection/connection-state.js';
import { EventBus } from '../../../../src/central/event-bus.js';
import { ClientState } from '../../../../src/transport/resilience/state-machine.js';
import type { CentralEvent } from '../../../../src/central/events.js';

describe('central/connection/ConnectionStateTracker', () => {
  it('setState records the state and getState returns it', () => {
    const t = new ConnectionStateTracker();
    expect(t.getState('iface-1')).toBe(ClientState.CREATED);
    t.setState('iface-1', ClientState.CONNECTED);
    expect(t.getState('iface-1')).toBe(ClientState.CONNECTED);
  });

  it('setState publishes connectionStateChanged on the injected bus', async () => {
    const bus = new EventBus();
    const events: CentralEvent[] = [];
    bus.subscribe({ type: 'connectionStateChanged', handler: (e) => void events.push(e) });
    const t = new ConnectionStateTracker({ eventBus: bus });

    t.setState('iface-1', ClientState.CONNECTED, 'recovered');
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toMatchObject({
      type: 'connectionStateChanged',
      interfaceId: 'iface-1',
      state: ClientState.CONNECTED,
      reason: 'recovered',
    });
  });

  it('add/remove/has/clear issues', () => {
    const t = new ConnectionStateTracker();
    expect(t.hasIssue('iface-1')).toBe(false);
    t.addIssue('iface-1', 'json');
    t.addIssue('iface-1', 'rpc');
    expect(t.hasIssue('iface-1', 'json')).toBe(true);
    expect(t.hasIssue('iface-1', 'callback')).toBe(false);
    expect(t.hasIssue('iface-1')).toBe(true);
    t.removeIssue('iface-1', 'json');
    expect(t.hasIssue('iface-1', 'json')).toBe(false);
    expect(t.hasIssue('iface-1')).toBe(true);
    t.clearIssues('iface-1');
    expect(t.hasIssue('iface-1')).toBe(false);
  });

  it('callback liveness is alive when no event has been recorded yet', () => {
    const now = 0;
    const t = new ConnectionStateTracker({ now: () => now });
    expect(t.isCallbackAlive('iface-1')).toBe(true);
  });

  it('callback liveness flips false after the warn interval (injected clock)', () => {
    let now = 1000;
    const t = new ConnectionStateTracker({ now: () => now });
    t.recordEvent('iface-1');
    now = 1000 + 180_000;
    expect(t.isCallbackAlive('iface-1', 180_000)).toBe(true);
    now = 1000 + 180_001;
    expect(t.isCallbackAlive('iface-1', 180_000)).toBe(false);
  });

  it('recordEvent accepts an explicit timestamp', () => {
    let now = 5000;
    const t = new ConnectionStateTracker({ now: () => now });
    t.recordEvent('iface-1', 1000);
    now = 1000 + 180_001;
    expect(t.isCallbackAlive('iface-1', 180_000)).toBe(false);
  });
});
