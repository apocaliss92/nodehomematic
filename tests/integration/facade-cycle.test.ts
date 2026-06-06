/**
 * Integration test for the {@link Homematic} facade against an in-process
 * {@link FakeCcu} — NO hardware, NO mocks of our own modules. The facade builds
 * a REAL CentralUnit (real InterfaceClient / CallbackServer / JsonRpcClient /
 * caches); only the transport URLs + an in-memory storage backend are injected
 * so the test is fast and hermetic.
 *
 * Covers: start → devices() populated with data points; a CCU push → public
 * `valueChanged`; setValue reaching the CCU; getConfigParams/getConfig/setConfig
 * over the MASTER paramset (asserted against the FakeCcu); clean stop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { Homematic, createHomematicForTest } from '../../src/api/homematic.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { Interface } from '../../src/support/constants.js';
import type { ValueChangedEvent } from '../../src/api/events.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
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

function buildFacade(fakeCcu: FakeCcu, storage: InMemoryStorageBackend): Homematic {
  // Build a real CentralUnit pointed at the fake CCU, injected into the facade.
  // A holder lets the InterfaceClient's callbackUrlProvider read the central's
  // bound port lazily without a `let` reassignment.
  const holder: { central?: CentralUnit } = {};
  const central = new CentralUnit({
    centralName: CENTRAL_NAME,
    host: CALLBACK_HOST,
    interfaces: [Interface.HMIP_RF],
    credentials: { username: USERNAME, password: PASSWORD },
    callback: { host: CALLBACK_HOST, port: 0 },
    storageBackend: storage,
    jsonClient: new JsonRpcClient({ url: fakeCcu.jsonRpcUrl }),
    makeInterfaceClient: (iface) =>
      new InterfaceClient({
        centralName: CENTRAL_NAME,
        interface: iface,
        host: CALLBACK_HOST,
        port: fakeCcu.port,
        callbackUrlProvider: () => `http://${CALLBACK_HOST}:${holder.central?.callbackPort ?? 0}`,
      }),
    timings: { connectionCheckMs: 60_000, valueRefreshMs: 60_000 },
    recoverySleep: () => Promise.resolve(),
  });
  holder.central = central;
  return createHomematicForTest(
    {
      host: CALLBACK_HOST,
      interfaces: ['HmIP-RF'],
      callback: { host: CALLBACK_HOST, port: 0 },
    },
    { central },
  );
}

describe('facade cycle (fake CCU, real central + transport modules)', () => {
  let fakeCcu: FakeCcu;
  let storage: InMemoryStorageBackend;
  let hm: Homematic;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({ username: USERNAME, password: PASSWORD });
    await fakeCcu.start();
    storage = new InMemoryStorageBackend();
    hm = buildFacade(fakeCcu, storage);
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
    await fakeCcu.stop();
  });

  it('exposes devices() populated with data points', () => {
    const devices = hm.devices();
    expect(devices).toHaveLength(1);
    const device = devices[0]!;
    expect(device.address).toBe('VCU0000001');
    expect(device.type).toBe('HmIP-SWDO');
    expect(device.name).toBe('Window Contact');
    const channel1 = device.channels.find((c) => c.address === 'VCU0000001:1')!;
    const params = channel1.dataPoints.map((dp) => dp.parameter).sort();
    expect(params).toEqual(['LEVEL', 'STATE']);
    const state = channel1.dataPoints.find((dp) => dp.parameter === 'STATE')!;
    expect(state.type).toBe('BOOL');
    expect(state.readable).toBe(true);
  });

  it('surfaces the device descriptor firmware fields on devices()', () => {
    const device = hm.devices()[0]!;
    expect(device.firmware).toBe('1.18.24');
    expect(device.availableFirmware).toBe('1.18.24');
    expect(device.updatable).toBe(true);
    expect(device.firmwareUpdateState).toBe('UP_TO_DATE');
  });

  it('installFirmware dispatches the XML-RPC command to the CCU', async () => {
    await hm.installFirmware('VCU0000001');
    expect(fakeCcu.didInstallFirmware('VCU0000001')).toBe(true);
  });

  it('installFirmware rejects an unknown device before hitting the wire', async () => {
    await expect(hm.installFirmware('NOPE')).rejects.toThrow(/Unknown device/);
    expect(fakeCcu.didInstallFirmware('NOPE')).toBe(false);
  });

  it('reflects seeded initial values in getValue() right after start (no push)', async () => {
    // The shared fakeCcu/storage are recreated per test in beforeEach, but this
    // test needs the value stored BEFORE start(). Build a dedicated facade here.
    await hm.stop();
    fakeCcu.setStoredValue('VCU0000001:1', 'STATE', true);
    hm = buildFacade(fakeCcu, storage);
    await hm.start();

    // No emitEvent: the value was seeded during start() via getParamset(VALUES).
    expect(hm.getValue({ device: 'VCU0000001', channel: 1, parameter: 'STATE' })).toBe(true);
  });

  it('re-emits a CCU push as a public valueChanged', async () => {
    const events: ValueChangedEvent[] = [];
    hm.on('valueChanged', (e) => events.push(e));

    await fakeCcu.emitEvent('VCU0000001:1', 'STATE', true);
    await waitFor(() => events.length > 0);

    expect(events[0]).toMatchObject({
      device: 'VCU0000001',
      channel: 'VCU0000001:1',
      parameter: 'STATE',
      value: true,
    });
    expect(hm.getValue({ device: 'VCU0000001', channel: 1, parameter: 'STATE' })).toBe(true);
  });

  it('setValue reaches the CCU', async () => {
    await hm.setValue({ device: 'VCU0000001', channel: 1, parameter: 'STATE' }, false);
    expect(fakeCcu.storedValue('VCU0000001:1', 'STATE')).toBe(false);
  });

  it('getConfigParams returns the advertised MASTER parameters', () => {
    const params = hm.getConfigParams('VCU0000001:1');
    const numeric = params.find((p) => p.parameter === 'CYCLIC_INFO_MSG_DIS');
    expect(numeric).toMatchObject({ type: 'INTEGER', min: 0, max: 100, writable: true });
  });

  it('getConfig reads the current MASTER values', async () => {
    const config = await hm.getConfig('VCU0000001:1');
    // DEFAULT from the description until something is written.
    expect(config['CYCLIC_INFO_MSG_DIS']).toBe(28);
  });

  it('setConfig writes the MASTER values (verified via the CCU)', async () => {
    await hm.setConfig('VCU0000001:1', { CYCLIC_INFO_MSG_DIS: 77 });
    expect(fakeCcu.storedValue('VCU0000001:1', 'CYCLIC_INFO_MSG_DIS')).toBe(77);
    const config = await hm.getConfig('VCU0000001:1');
    expect(config['CYCLIC_INFO_MSG_DIS']).toBe(77);
  });
});
