/**
 * Ping/pong stability against the {@link FakeCcu}, which now echoes the real
 * CCU behaviour: a `ping(callerId)` is answered with `true` AND an async PONG
 * event whose value is the callerId verbatim.
 *
 * Regression guard: the central must record the SAME token it sends as the
 * callerId (`${interfaceId}#${seq}`), so every echoed pong reconciles against a
 * pending ping. If the recorded token diverges from the sent callerId (the old
 * bare-seq bug), every pong lands in the "unknown" bucket; after the mismatch
 * threshold the interface is wrongly declared lost and the central enters an
 * endless RECONNECTING loop. Here we drive MANY connection-check passes (well
 * past the threshold) and assert the interface stays CONNECTED with no spurious
 * recovery.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { Interface } from '../../src/support/constants.js';
import { RecoveryStage } from '../../src/central/connection/recovery.js';
import { DEFAULT_PING_PONG_MISMATCH_COUNT } from '../../src/central/connection/ping-pong.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
const INTERFACE_ID = 'TestCCU-HmIP-RF';
const HOST = '127.0.0.1';

/** Yield to the macrotask queue so the async PONG POST is delivered + routed. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('central ping/pong stability (fake CCU echoes pongs)', () => {
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

  it('stays CONNECTED across many connection-check passes (no spurious RECONNECTING)', async () => {
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
      // Drive connectionCheck() explicitly; disable autonomous timers.
      timings: { connectionCheckMs: 3_600_000, valueRefreshMs: 3_600_000 },
      recoverySleep: () => Promise.resolve(),
      tcpProbe: () => Promise.resolve(true),
    });

    const stages: RecoveryStage[] = [];
    central.eventBus.subscribe({
      type: 'recoveryStageChanged',
      handler: (event) => void stages.push(event.stage as RecoveryStage),
    });
    const connStates: string[] = [];
    central.eventBus.subscribe({
      type: 'connectionStateChanged',
      handler: (event) => void connStates.push(event.state),
    });

    await central.start();
    expect(fakeCcu.lastRegistration?.interfaceId).toBe(INTERFACE_ID);

    // Drive far more passes than the mismatch threshold: with bare-seq tokens
    // every pong would be "unknown" and the interface would flip to RECONNECTING
    // after the threshold. With matched tokens each pong reconciles its ping.
    const passes = DEFAULT_PING_PONG_MISMATCH_COUNT + 10;
    for (let i = 0; i < passes; i += 1) {
      await central.connectionCheck();
      // Let the async PONG push arrive + route before the next isMismatch check.
      await flush();
    }

    // No recovery was ever triggered: the interface stayed healthy. The only
    // state transition observed at start is the initial CONNECTED; no
    // RECONNECTING / FAILED transition occurs because no loss is detected.
    expect(stages).not.toContain(RecoveryStage.RECONNECTING);
    expect(connStates).not.toContain('RECONNECTING');
    expect(connStates).not.toContain('FAILED');
    expect(connStates[connStates.length - 1]).toBe('CONNECTED');
  });
});
