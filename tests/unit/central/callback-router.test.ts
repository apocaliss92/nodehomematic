import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CallbackRouter, PONG_PARAMETER } from '../../../src/central/callback-router.js';
import { EventBus } from '../../../src/central/event-bus.js';
import { ValueCache } from '../../../src/central/store/value-cache.js';
import { DeviceRegistry } from '../../../src/central/device-registry.js';
import { ConnectionStateTracker } from '../../../src/central/connection/connection-state.js';
import { PingPongTracker } from '../../../src/central/connection/ping-pong.js';
import { ParameterType } from '../../../src/support/constants.js';
import type { CentralEvent } from '../../../src/central/events.js';
import type { DeviceNode } from '../../../src/central/graph.js';
import type { RawCallbackEvent } from '../../../src/transport/callback-server/events.js';

const INTERFACE_ID = 'test-HmIP-RF';

function makeNode(address: string): DeviceNode {
  return {
    address,
    type: 'HmIP-SWDO',
    interfaceId: INTERFACE_ID,
    channels: [
      {
        address: `${address}:1`,
        index: 1,
        parameters: new Map([
          [
            'STATE',
            {
              VALUES: {
                type: ParameterType.BOOL,
                operations: 7,
                flags: 1,
                readable: true,
                writable: true,
                hasEvents: true,
                visible: true,
              },
            },
          ],
        ]),
      },
    ],
    raw: { ADDRESS: address, TYPE: 'HmIP-SWDO' },
  };
}

interface Harness {
  readonly router: CallbackRouter;
  readonly bus: EventBus;
  readonly events: CentralEvent[];
  readonly valueCache: ValueCache;
  readonly registry: DeviceRegistry;
  readonly state: ConnectionStateTracker;
  readonly pingPong: PingPongTracker;
  readonly onNewDevices: ReturnType<typeof vi.fn>;
  readonly onUpdateDevice: ReturnType<typeof vi.fn>;
  readonly onReaddDevices: ReturnType<typeof vi.fn>;
}

function buildHarness(): Harness {
  const bus = new EventBus();
  const events: CentralEvent[] = [];
  for (const type of [
    'valueReceived',
    'deviceRemoved',
    'deviceAdded',
    'devicesCreated',
    'systemError',
  ] as const) {
    bus.subscribe({ type, handler: (event) => void events.push(event) });
  }
  const valueCache = new ValueCache();
  const registry = new DeviceRegistry();
  const state = new ConnectionStateTracker({ now: () => 1000 });
  const pingPong = new PingPongTracker({ now: () => 1000 });
  const onNewDevices = vi.fn(() => Promise.resolve());
  const onUpdateDevice = vi.fn(() => Promise.resolve());
  const onReaddDevices = vi.fn(() => Promise.resolve());
  const router = new CallbackRouter({
    eventBus: bus,
    valueCache,
    registry,
    connectionState: state,
    pingPongFor: () => pingPong,
    now: () => 5000,
    hooks: { onNewDevices, onUpdateDevice, onReaddDevices },
  });
  return {
    router,
    bus,
    events,
    valueCache,
    registry,
    state,
    pingPong,
    onNewDevices,
    onUpdateDevice,
    onReaddDevices,
  };
}

describe('CallbackRouter', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('routes a value event into the cache and publishes valueReceived', async () => {
    const raw: RawCallbackEvent = {
      type: 'event',
      interfaceId: INTERFACE_ID,
      channelAddress: 'VCU1:1',
      parameter: 'STATE',
      value: true,
    };
    await h.router.route(raw);

    const value = h.events.find((e) => e.type === 'valueReceived');
    expect(value).toMatchObject({ type: 'valueReceived', value: true, receivedAt: 5000 });
    expect(
      h.valueCache.get({
        interfaceId: INTERFACE_ID,
        channelAddress: 'VCU1:1',
        paramsetKey: 'VALUES',
        parameter: 'STATE',
      })?.value,
    ).toBe(true);
    // Inbound event marks the callback channel alive.
    expect(h.state.isCallbackAlive(INTERFACE_ID, 180_000, 1000)).toBe(true);
  });

  it('reconciles a PONG event with the ping/pong tracker (no value published)', async () => {
    // Our own ping tokens are `${interfaceId}#${seq}`; only those reconcile.
    const ownToken = `${INTERFACE_ID}#1`;
    h.pingPong.handleSendPing(ownToken);
    expect(h.pingPong.pendingCount).toBe(1);

    await h.router.route({
      type: 'event',
      interfaceId: INTERFACE_ID,
      channelAddress: 'CENTRAL',
      parameter: PONG_PARAMETER,
      value: ownToken,
    });

    expect(h.pingPong.pendingCount).toBe(0);
    expect(h.events.some((e) => e.type === 'valueReceived')).toBe(false);
  });

  it('ignores a FOREIGN PONG whose token is not ours (no reconcile, no unknown)', async () => {
    // The CCU broadcasts every client's PONG to all callbacks. A foreign token
    // (another central, e.g. Home Assistant) must NOT reconcile our pending
    // ping nor pollute the unknown bucket that drives the mismatch detector.
    h.pingPong.handleSendPing(`${INTERFACE_ID}#1`);
    expect(h.pingPong.pendingCount).toBe(1);

    await h.router.route({
      type: 'event',
      interfaceId: INTERFACE_ID,
      channelAddress: 'CENTRAL',
      parameter: PONG_PARAMETER,
      value: 'Casa-HmIP-RF#06.06.2026 10:27:59',
    });

    // Pending ping untouched, foreign pong dropped (not counted as unknown).
    expect(h.pingPong.pendingCount).toBe(1);
    expect(h.pingPong.unknownCount).toBe(0);
    expect(h.events.some((e) => e.type === 'valueReceived')).toBe(false);
  });

  it('delegates newDevices to the discovery hook', async () => {
    await h.router.route({
      type: 'newDevices',
      interfaceId: INTERFACE_ID,
      descriptions: [{ ADDRESS: 'VCU9' }, { TYPE: 'no-address' }],
    });
    expect(h.onNewDevices).toHaveBeenCalledWith(INTERFACE_ID, ['VCU9']);
  });

  it('ignores newDevices with no usable addresses', async () => {
    await h.router.route({
      type: 'newDevices',
      interfaceId: INTERFACE_ID,
      descriptions: [{ TYPE: 'x' }],
    });
    expect(h.onNewDevices).not.toHaveBeenCalled();
  });

  it('removes devices and publishes deviceRemoved on deleteDevices', async () => {
    h.registry.upsert(makeNode('VCU9'));
    await h.router.route({
      type: 'deleteDevices',
      interfaceId: INTERFACE_ID,
      addresses: ['VCU9'],
    });
    expect(h.registry.get('VCU9')).toBeUndefined();
    expect(h.events.some((e) => e.type === 'deviceRemoved' && e.address === 'VCU9')).toBe(true);
  });

  it('resolves a channel delete to its owning device', async () => {
    h.registry.upsert(makeNode('VCU9'));
    await h.router.route({
      type: 'deleteDevices',
      interfaceId: INTERFACE_ID,
      addresses: ['VCU9:1'],
    });
    expect(h.registry.get('VCU9')).toBeUndefined();
  });

  it('re-discovers a device on updateDevice', async () => {
    await h.router.route({
      type: 'updateDevice',
      interfaceId: INTERFACE_ID,
      address: 'VCU9',
      hint: 0,
    });
    expect(h.onUpdateDevice).toHaveBeenCalledWith(INTERFACE_ID, 'VCU9');
  });

  it('handles replaceDevice as remove-old + discover-new', async () => {
    h.registry.upsert(makeNode('OLD'));
    await h.router.route({
      type: 'replaceDevice',
      interfaceId: INTERFACE_ID,
      oldAddress: 'OLD',
      newAddress: 'NEW',
    });
    expect(h.registry.get('OLD')).toBeUndefined();
    expect(h.onReaddDevices).toHaveBeenCalledWith(INTERFACE_ID, ['NEW']);
  });

  it('handles readdedDevice (remove + re-discover same addresses)', async () => {
    h.registry.upsert(makeNode('VCU9'));
    await h.router.route({
      type: 'readdedDevice',
      interfaceId: INTERFACE_ID,
      addresses: ['VCU9'],
    });
    expect(h.onReaddDevices).toHaveBeenCalledWith(INTERFACE_ID, ['VCU9']);
  });

  it('publishes systemError on an error event', async () => {
    await h.router.route({
      type: 'error',
      interfaceId: INTERFACE_ID,
      code: 7,
      message: 'boom',
    });
    expect(
      h.events.some((e) => e.type === 'systemError' && e.code === 7 && e.message === 'boom'),
    ).toBe(true);
  });
});
