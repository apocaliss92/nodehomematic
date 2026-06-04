/**
 * Integration test for the {@link Homematic} facade's custom-entity surface
 * against an in-process {@link FakeCcu} — NO hardware, NO mocks of our own
 * modules. The facade builds a REAL CentralUnit (real InterfaceClient /
 * CallbackServer / JsonRpcClient); only the transport URLs + an in-memory
 * storage backend are injected.
 *
 * The fake CCU advertises an extra HmIP switching plug (HmIP-PS) which maps to
 * the custom Switch entity. Covers: start → `customEntities()` contains the
 * switch with correct state after a CCU push → `switchTurnOn` reaches the CCU
 * (asserted via the FakeCcu inspector) → clean stop. Deterministic (waitFor).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { Homematic, createHomematicForTest } from '../../src/api/homematic.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { Interface } from '../../src/support/constants.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
const CALLBACK_HOST = '127.0.0.1';

const READ_WRITE_EVENT = 1 | 2 | 4;

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
    { host: CALLBACK_HOST, interfaces: ['HmIP-RF'], callback: { host: CALLBACK_HOST, port: 0 } },
    { central },
  );
}

describe('custom-entity cycle (fake CCU, real central + transport modules)', () => {
  let fakeCcu: FakeCcu;
  let storage: InMemoryStorageBackend;
  let hm: Homematic;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({
      username: USERNAME,
      password: PASSWORD,
      // An HmIP switching plug — maps to the custom Switch entity (STATE on the
      // dedicated virtual-receiver channel :3).
      extraDevices: [
        {
          ADDRESS: 'VCU0000002',
          TYPE: 'HmIP-PS',
          FIRMWARE: '1.0.0',
          PARAMSETS: ['MASTER'],
          CHILDREN: ['VCU0000002:0', 'VCU0000002:3'],
        },
        {
          ADDRESS: 'VCU0000002:0',
          TYPE: 'MAINTENANCE',
          PARENT: 'VCU0000002',
          PARAMSETS: ['MASTER'],
        },
        {
          ADDRESS: 'VCU0000002:3',
          TYPE: 'SWITCH_TRANSCEIVER',
          PARENT: 'VCU0000002',
          PARAMSETS: ['VALUES'],
        },
      ],
      extraParamsets: {
        'VCU0000002:3|VALUES': {
          STATE: { TYPE: 'BOOL', OPERATIONS: READ_WRITE_EVENT, FLAGS: 1 },
        },
        'VCU0000002:0|MASTER': {},
        'VCU0000002|MASTER': {},
      },
    });
    await fakeCcu.start();
    storage = new InMemoryStorageBackend();
    hm = buildFacade(fakeCcu, storage);
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
    await fakeCcu.stop();
  });

  it('customEntities() contains the switch with state reflecting a CCU push', async () => {
    const before = hm.customEntities().find((e) => e.device === 'VCU0000002');
    expect(before).toMatchObject({ kind: 'switch', channel: 'VCU0000002:3', isOn: false });

    await fakeCcu.emitEvent('VCU0000002:3', 'STATE', true);
    await waitFor(() => {
      const sw = hm.customEntities().find((e) => e.device === 'VCU0000002');
      return sw?.kind === 'switch' && sw.isOn;
    });

    const after = hm.customEntities().find((e) => e.device === 'VCU0000002');
    expect(after).toMatchObject({ kind: 'switch', isOn: true });
  });

  it('switchTurnOn reaches the CCU', async () => {
    await hm.switchTurnOn('VCU0000002', 3);
    expect(fakeCcu.storedValue('VCU0000002:3', 'STATE')).toBe(true);
  });

  it('switchTurnOff reaches the CCU', async () => {
    await hm.switchTurnOff('VCU0000002', 3);
    expect(fakeCcu.storedValue('VCU0000002:3', 'STATE')).toBe(false);
  });
});
