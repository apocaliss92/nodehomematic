/**
 * Rock-solid reconnect, end to end against the {@link FakeCcu}.
 *
 * The real CentralUnit runs a connection-check; the fake CCU "falls over"
 * (`dropConnection`) so the check detects a loss and {@link ConnectionRecovery}
 * runs its staged machine. The CCU is `restore()`d once recovery reaches its
 * TCP probe so the RPC checks pass, the proxy re-initialises (re-registering the
 * callback URL) and values re-sync. We assert the machine reaches RECOVERED, the
 * connection state ends at CONNECTED and a fresh CCU push still arrives.
 *
 * All recovery delays go through an injected near-immediate sleep, and the
 * connection-check is driven explicitly, so the test is fast and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { Interface } from '../../src/support/constants.js';
import { makeDpk } from '../../src/support/dpk.js';
import { RecoveryStage } from '../../src/central/connection/recovery.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
const INTERFACE_ID = 'TestCCU-HmIP-RF';
const HOST = '127.0.0.1';

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

describe('central reconnect (fake CCU drop/restore)', () => {
  let fakeCcu: FakeCcu;
  let storage: InMemoryStorageBackend;
  let central: CentralUnit;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({ username: USERNAME, password: PASSWORD });
    await fakeCcu.start();
    storage = new InMemoryStorageBackend();
  });

  afterEach(async () => {
    await central.stop();
    await fakeCcu.stop();
  });

  it('detects a loss, recovers through the stages, and re-registers the callback', async () => {
    const jsonClient = new JsonRpcClient({ url: fakeCcu.jsonRpcUrl });
    central = new CentralUnit({
      centralName: CENTRAL_NAME,
      host: HOST,
      interfaces: [Interface.HMIP_RF],
      credentials: { username: USERNAME, password: PASSWORD },
      callback: { host: HOST, port: 0 },
      storageBackend: storage,
      jsonClient,
      makeInterfaceClient: (iface) =>
        new InterfaceClient({
          centralName: CENTRAL_NAME,
          interface: iface,
          host: HOST,
          port: fakeCcu.port,
          callbackUrlProvider: () => `http://${HOST}:${central.callbackPort}`,
        }),
      // Disable autonomous health checks; we drive connectionCheck() explicitly.
      timings: { connectionCheckMs: 3_600_000, valueRefreshMs: 3_600_000 },
      // Near-immediate recovery delays keep the test fast and deterministic.
      recoverySleep: () => Promise.resolve(),
      // The fake CCU's HTTP socket stays bound even while "down", so TCP is up
      // while RPC is down — exactly the CCU-restart signal. Probe its real port.
      tcpProbe: () => Promise.resolve(true),
    });

    const stages: RecoveryStage[] = [];
    const connStates: string[] = [];
    central.eventBus.subscribe({
      type: 'recoveryStageChanged',
      handler: (event) => {
        stages.push(event.stage as RecoveryStage);
        // Restore the CCU as soon as recovery starts probing TCP, so the
        // subsequent RPC checks + reconnect succeed (mirrors a CCU finishing
        // its restart while recovery is mid-flight).
        if (event.stage === RecoveryStage.TCP_CHECKING) {
          fakeCcu.restore();
        }
      },
    });
    central.eventBus.subscribe({
      type: 'connectionStateChanged',
      handler: (event) => void connStates.push(event.state),
    });

    await central.start();
    expect(fakeCcu.lastRegistration?.interfaceId).toBe(INTERFACE_ID);

    // The CCU falls over: the registration is dropped and RPC starts failing.
    fakeCcu.dropConnection();
    expect(fakeCcu.lastRegistration).toBeUndefined();

    // Drive one connection-check pass: ping fails → loss → recovery runs to
    // completion (restore() above lets the RPC/reconnect stages pass).
    await central.connectionCheck();

    // The machine walked the full runtime path and reached RECOVERED.
    expect(stages).toContain(RecoveryStage.RECONNECTING);
    expect(stages).toContain(RecoveryStage.DATA_LOADING);
    expect(stages[stages.length - 1]).toBe(RecoveryStage.RECOVERED);

    // The callback URL was re-registered during RECONNECTING (deinit+init).
    await waitFor(() => fakeCcu.lastRegistration?.interfaceId === INTERFACE_ID);
    expect(fakeCcu.lastRegistration?.interfaceId).toBe(INTERFACE_ID);

    // Connection state transitioned RECONNECTING → CONNECTED.
    expect(connStates).toContain('RECONNECTING');
    expect(connStates[connStates.length - 1]).toBe('CONNECTED');

    // A fresh push after recovery still routes — the callback path is alive.
    let received = false;
    central.eventBus.subscribe({
      type: 'valueReceived',
      key: undefined,
      handler: () => void (received = true),
    });
    await fakeCcu.emitEvent('VCU0000001:1', 'STATE', false);
    await waitFor(() => received);
    expect(central.getValue(makeDpk(INTERFACE_ID, 'VCU0000001:1', 'VALUES', 'STATE'))).toBe(false);
  });

  it('re-syncs values during recovery DATA_LOADING', async () => {
    const jsonClient = new JsonRpcClient({ url: fakeCcu.jsonRpcUrl });
    central = new CentralUnit({
      centralName: CENTRAL_NAME,
      host: HOST,
      interfaces: [Interface.HMIP_RF],
      callback: { host: HOST, port: 0 },
      storageBackend: storage,
      jsonClient,
      makeInterfaceClient: (iface) =>
        new InterfaceClient({
          centralName: CENTRAL_NAME,
          interface: iface,
          host: HOST,
          port: fakeCcu.port,
          callbackUrlProvider: () => `http://${HOST}:${central.callbackPort}`,
        }),
      timings: { connectionCheckMs: 3_600_000, valueRefreshMs: 3_600_000 },
      recoverySleep: () => Promise.resolve(),
      tcpProbe: () => Promise.resolve(true),
    });

    central.eventBus.subscribe({
      type: 'recoveryStageChanged',
      handler: (event) => {
        if (event.stage === RecoveryStage.TCP_CHECKING) fakeCcu.restore();
      },
    });

    await central.start();

    // Seed a fresh value the re-sync should pick up via getValue.
    await fakeCcu.emitEvent('VCU0000001:1', 'STATE', false);
    await new Promise((r) => setTimeout(r, 20));
    // setValue stores it server-side so the post-recovery getValue returns it.
    await central.setValue(makeDpk(INTERFACE_ID, 'VCU0000001:1', 'VALUES', 'STATE'), true);

    fakeCcu.dropConnection();
    await central.connectionCheck();

    await waitFor(() => fakeCcu.lastRegistration?.interfaceId === INTERFACE_ID);
    // After DATA_LOADING re-sync, the value cache reflects the server value.
    expect(central.getValue(makeDpk(INTERFACE_ID, 'VCU0000001:1', 'VALUES', 'STATE'))).toBe(true);
  });

  it('recovers via the getVersion fallback when listMethods is unavailable', async () => {
    const jsonClient = new JsonRpcClient({ url: fakeCcu.jsonRpcUrl });
    central = new CentralUnit({
      centralName: CENTRAL_NAME,
      host: HOST,
      interfaces: [Interface.HMIP_RF],
      callback: { host: HOST, port: 0 },
      storageBackend: storage,
      jsonClient,
      makeInterfaceClient: (iface) =>
        new InterfaceClient({
          centralName: CENTRAL_NAME,
          interface: iface,
          host: HOST,
          port: fakeCcu.port,
          callbackUrlProvider: () => `http://${HOST}:${central.callbackPort}`,
        }),
      timings: { connectionCheckMs: 3_600_000, valueRefreshMs: 3_600_000 },
      recoverySleep: () => Promise.resolve(),
      tcpProbe: () => Promise.resolve(true),
    });

    const stages: RecoveryStage[] = [];
    central.eventBus.subscribe({
      type: 'recoveryStageChanged',
      handler: (event) => {
        stages.push(event.stage as RecoveryStage);
        if (event.stage === RecoveryStage.TCP_CHECKING) {
          fakeCcu.restore();
          // RPC is back, but listMethods faults → rpcCheck must fall back to
          // getVersion (still succeeds), so recovery proceeds.
          fakeCcu.setListMethodsFails(true);
        }
      },
    });

    await central.start();
    fakeCcu.dropConnection();
    await central.connectionCheck();

    expect(stages[stages.length - 1]).toBe(RecoveryStage.RECOVERED);
    fakeCcu.setListMethodsFails(false);
  });

  it('marks the interface FAILED when recovery never succeeds', async () => {
    const jsonClient = new JsonRpcClient({ url: fakeCcu.jsonRpcUrl });
    central = new CentralUnit({
      centralName: CENTRAL_NAME,
      host: HOST,
      interfaces: [Interface.HMIP_RF],
      callback: { host: HOST, port: 0 },
      storageBackend: storage,
      jsonClient,
      makeInterfaceClient: (iface) =>
        new InterfaceClient({
          centralName: CENTRAL_NAME,
          interface: iface,
          host: HOST,
          port: fakeCcu.port,
          callbackUrlProvider: () => `http://${HOST}:${central.callbackPort}`,
        }),
      timings: { connectionCheckMs: 3_600_000, valueRefreshMs: 3_600_000 },
      recoverySleep: () => Promise.resolve(),
      // TCP probe always fails → recovery can never proceed → FAILED.
      tcpProbe: () => Promise.resolve(false),
    });

    const connStates: string[] = [];
    central.eventBus.subscribe({
      type: 'connectionStateChanged',
      handler: (event) => void connStates.push(event.state),
    });

    await central.start();
    fakeCcu.dropConnection();
    await central.connectionCheck();

    expect(connStates).toContain('FAILED');
  });
});
