import { describe, it, expect, vi } from 'vitest';
import { EventBus, EventPriority } from '../../../src/central/event-bus.js';
import { eventKey, type CentralEvent } from '../../../src/central/events.js';
import { makeDpk, dpkToUniqueId } from '../../../src/support/dpk.js';

function valueEvent(channelAddress: string, value: unknown): CentralEvent {
  return {
    type: 'valueReceived',
    dpk: makeDpk('iface-1', channelAddress, 'VALUES', 'STATE'),
    value,
    receivedAt: 123,
  };
}

describe('central/events', () => {
  it('eventKey returns the natural key for each type', () => {
    expect(eventKey(valueEvent('VCU1:1', true))).toBe(
      dpkToUniqueId(makeDpk('iface-1', 'VCU1:1', 'VALUES', 'STATE')),
    );
    expect(eventKey({ type: 'deviceAdded', address: 'ABC' })).toBe('ABC');
    expect(eventKey({ type: 'deviceRemoved', address: 'XYZ' })).toBe('XYZ');
    expect(eventKey({ type: 'devicesCreated', addresses: ['A', 'B'] })).toBeUndefined();
    expect(eventKey({ type: 'connectionStateChanged', interfaceId: 'iface-1', state: 'UP' })).toBe(
      'iface-1',
    );
    expect(eventKey({ type: 'recoveryStageChanged', interfaceId: 'iface-2', stage: 'IDLE' })).toBe(
      'iface-2',
    );
    expect(eventKey({ type: 'systemError', interfaceId: 'iface-3', code: 1, message: 'x' })).toBe(
      'iface-3',
    );
    expect(eventKey({ type: 'ready' })).toBeUndefined();
  });
});

describe('central/event-bus', () => {
  it('subscribe by type receives the matching event', async () => {
    const bus = new EventBus();
    const received: CentralEvent[] = [];
    bus.subscribe({ type: 'ready', handler: (e) => void received.push(e) });
    await bus.publish({ type: 'ready' });
    expect(received).toEqual([{ type: 'ready' }]);
    expect(bus.subscriptionCount).toBe(1);
  });

  it('does not deliver events of a different type', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe({ type: 'deviceAdded', handler });
    await bus.publish({ type: 'deviceRemoved', address: 'A' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('key-specific receives only its key, wildcard receives everything of the type', async () => {
    const bus = new EventBus();
    const keyed: string[] = [];
    const wild: string[] = [];
    bus.subscribe({
      type: 'deviceAdded',
      key: 'ABC',
      handler: (e) => void keyed.push(e.address),
    });
    bus.subscribe({ type: 'deviceAdded', handler: (e) => void wild.push(e.address) });

    await bus.publish({ type: 'deviceAdded', address: 'ABC' });
    await bus.publish({ type: 'deviceAdded', address: 'OTHER' });

    expect(keyed).toEqual(['ABC']);
    expect(wild).toEqual(['ABC', 'OTHER']);
  });

  it('respects the priority order then insertion order', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe({
      type: 'ready',
      priority: EventPriority.LOW,
      handler: () => void order.push('low'),
    });
    bus.subscribe({
      type: 'ready',
      priority: EventPriority.CRITICAL,
      handler: () => void order.push('critical'),
    });
    bus.subscribe({
      type: 'ready',
      priority: EventPriority.NORMAL,
      handler: () => void order.push('normal-1'),
    });
    bus.subscribe({
      type: 'ready',
      priority: EventPriority.NORMAL,
      handler: () => void order.push('normal-2'),
    });

    await bus.publish({ type: 'ready' });
    expect(order).toEqual(['critical', 'normal-1', 'normal-2', 'low']);
  });

  it('a handler that throws does not block the others and logs via the injected logger', async () => {
    const logger = { error: vi.fn() };
    const bus = new EventBus({ logger });
    const ran: string[] = [];
    bus.subscribe({
      type: 'ready',
      handler: () => {
        throw new Error('boom');
      },
    });
    bus.subscribe({ type: 'ready', handler: () => void ran.push('survivor') });

    await bus.publish({ type: 'ready' });

    expect(ran).toEqual(['survivor']);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.subscribe({ type: 'ready', handler });
    off();
    expect(bus.subscriptionCount).toBe(0);
    await bus.publish({ type: 'ready' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('publishBatch delivers all the events', async () => {
    const bus = new EventBus();
    const added: string[] = [];
    bus.subscribe({ type: 'deviceAdded', handler: (e) => void added.push(e.address) });
    await bus.publishBatch([
      { type: 'deviceAdded', address: 'A' },
      { type: 'deviceAdded', address: 'B' },
      { type: 'deviceRemoved', address: 'C' },
    ]);
    expect(added).toEqual(['A', 'B']);
  });

  it('clear removes all subscriptions', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe({ type: 'ready', handler });
    bus.clear();
    expect(bus.subscriptionCount).toBe(0);
    await bus.publish({ type: 'ready' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('async handlers are awaited', async () => {
    const bus = new EventBus();
    let done = false;
    bus.subscribe({
      type: 'ready',
      handler: async () => {
        await Promise.resolve();
        done = true;
      },
    });
    await bus.publish({ type: 'ready' });
    expect(done).toBe(true);
  });
});
