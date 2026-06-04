/**
 * End-to-end CentralUnit lifecycle against an in-process {@link FakeCcu} — NO
 * hardware and NO mocks of our own modules. The real CentralUnit wires the real
 * InterfaceClient / CallbackServer / JsonRpcClient / caches; only the transport
 * URLs and a shared in-memory storage backend are injected so the test is fast
 * and hermetic.
 *
 * Covers: discovery + ready, value routing, setValue, warm start, and stop.
 * The reconnect scenario lives in `central-reconnect.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { Interface } from '../../src/support/constants.js';
import { makeDpk } from '../../src/support/dpk.js';
import type { CentralEvent } from '../../src/central/events.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
const INTERFACE_ID = 'TestCCU-HmIP-RF';
const CALLBACK_HOST = '127.0.0.1';

/** Poll a predicate until true or timeout (no fixed sleeps). */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 3000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

interface Harness {
  readonly central: CentralUnit;
  readonly events: CentralEvent[];
}

function buildCentral(fakeCcu: FakeCcu, storage: InMemoryStorageBackend): Harness {
  const jsonClient = new JsonRpcClient({ url: fakeCcu.jsonRpcUrl });
  const central = new CentralUnit({
    centralName: CENTRAL_NAME,
    host: CALLBACK_HOST,
    interfaces: [Interface.HMIP_RF],
    credentials: { username: USERNAME, password: PASSWORD },
    callback: { host: CALLBACK_HOST, port: 0 },
    storageBackend: storage,
    jsonClient,
    makeInterfaceClient: (iface) =>
      new InterfaceClient({
        centralName: CENTRAL_NAME,
        interface: iface,
        host: CALLBACK_HOST,
        port: fakeCcu.port,
        callbackUrlProvider: () => `http://${CALLBACK_HOST}:${central.callbackPort}`,
      }),
    // Short scheduler intervals so health checks do not fire during the test.
    timings: { connectionCheckMs: 60_000, valueRefreshMs: 60_000 },
    recoverySleep: () => Promise.resolve(),
  });

  const events: CentralEvent[] = [];
  for (const type of [
    'ready',
    'valueReceived',
    'devicesCreated',
    'deviceAdded',
    'deviceRemoved',
  ] as const) {
    central.eventBus.subscribe({ type, handler: (event) => void events.push(event) });
  }
  return { central, events };
}

describe('central cycle (fake CCU, real central + transport modules)', () => {
  let fakeCcu: FakeCcu;
  let storage: InMemoryStorageBackend;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({ username: USERNAME, password: PASSWORD });
    await fakeCcu.start();
    storage = new InMemoryStorageBackend();
  });

  afterEach(async () => {
    await fakeCcu.stop();
  });

  it('discovers the device graph and emits ready', async () => {
    const { central, events } = buildCentral(fakeCcu, storage);
    await central.start();

    const devices = central.registry.getAll();
    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.address).toBe('VCU0000001');
    expect(device.type).toBe('HmIP-SWDO');
    expect(device.interfaceId).toBe(INTERFACE_ID);
    expect(device.name).toBe('Window Contact');
    // Channels :0 and :1 are linked via CHILDREN.
    expect(device.channels.map((c) => c.address)).toEqual(['VCU0000001:0', 'VCU0000001:1']);
    const channel1 = device.channels.find((c) => c.address === 'VCU0000001:1')!;
    expect([...channel1.parameters.keys()].sort()).toEqual(['CYCLIC_INFO_MSG', 'LEVEL', 'STATE']);
    expect(channel1.parameters.get('STATE')?.VALUES?.writable).toBe(true);

    expect(events.some((e) => e.type === 'ready')).toBe(true);
    expect(events.some((e) => e.type === 'devicesCreated')).toBe(true);

    await central.stop();
  });

  it('routes a pushed event into the value cache and a valueReceived event', async () => {
    const { central, events } = buildCentral(fakeCcu, storage);
    await central.start();

    const dpk = makeDpk(INTERFACE_ID, 'VCU0000001:1', 'VALUES', 'STATE');

    await fakeCcu.emitEvent('VCU0000001:1', 'STATE', true);
    await waitFor(() => events.some((e) => e.type === 'valueReceived'));

    const valueEvent = events.find((e) => e.type === 'valueReceived');
    expect(valueEvent).toMatchObject({ type: 'valueReceived', value: true });
    expect((valueEvent as { dpk: { parameter: string } }).dpk.parameter).toBe('STATE');
    expect(central.getValue(dpk)).toBe(true);

    await central.stop();
  });

  it('writes a value back to the CCU via setValue', async () => {
    const { central } = buildCentral(fakeCcu, storage);
    await central.start();

    const dpk = makeDpk(INTERFACE_ID, 'VCU0000001:1', 'VALUES', 'STATE');
    await central.setValue(dpk, false);

    expect(fakeCcu.storedValue('VCU0000001:1', 'STATE')).toBe(false);

    await central.stop();
  });

  it('warm-starts from a populated cache without re-fetching paramsets', async () => {
    // First run: cold discovery populates the shared storage backend.
    const first = buildCentral(fakeCcu, storage);
    await first.central.start();
    await first.central.stop();

    const fetchesAfterCold = fakeCcu.paramsetFetches;
    expect(fetchesAfterCold).toBeGreaterThan(0);

    // Second run on the SAME storage backend → warm start, no new paramset fetches.
    const second = buildCentral(fakeCcu, storage);
    await second.central.start();

    expect(fakeCcu.paramsetFetches).toBe(fetchesAfterCold);
    const devices = second.central.registry.getAll();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.channels.map((c) => c.address)).toEqual(['VCU0000001:0', 'VCU0000001:1']);

    await second.central.stop();
  });

  it('persists caches on stop', async () => {
    const { central } = buildCentral(fakeCcu, storage);
    await central.start();
    await central.stop();

    const deviceBlob = await storage.load('device_descriptions');
    const paramsetBlob = await storage.load('paramset_descriptions');
    expect(deviceBlob).not.toBeNull();
    expect(paramsetBlob).not.toBeNull();
    expect(deviceBlob).toContain('VCU0000001');
    expect(paramsetBlob).toContain('STATE');
  });
});
