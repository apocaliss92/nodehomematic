/**
 * A CCU reboot heals on its own, end to end against the {@link FakeCcu} with
 * real sessions: the CCU goes down, the JSON-RPC logins fail more than ten
 * times, the CCU comes back, and within one backoff window the SAME central is
 * logged in again, the callback is re-registered and a ReGa call succeeds — no
 * restart, no new client.
 *
 * The central builds its own JSON-RPC client and session manager (only the URL
 * is pointed at the fake), so the production session path is what runs. Time
 * is an injected clock; recovery sleeps are immediate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { Interface } from '../../src/support/constants.js';
import { RecoveryStage } from '../../src/central/connection/recovery.js';
import { CcuManagementError, LoginBackoffError } from '../../src/support/errors.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
const INTERFACE_ID = 'TestCCU-HmIP-RF';
const HOST = '127.0.0.1';

describe('CCU reboot: the central heals on its own', () => {
  let fakeCcu: FakeCcu;
  let central: CentralUnit;
  let clock: number;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({ username: USERNAME, password: PASSWORD, strictSessions: true });
    await fakeCcu.start();
    clock = 1_000_000_000;
  });

  afterEach(async () => {
    await central.stop();
    await fakeCcu.stop();
  });

  it('re-logs in, re-inits and serves ReGa after >10 failed logins, without a new client', async () => {
    central = new CentralUnit({
      centralName: CENTRAL_NAME,
      host: HOST,
      interfaces: [Interface.HMIP_RF],
      credentials: { username: USERNAME, password: PASSWORD },
      callback: { host: HOST, port: 0 },
      storageBackend: new InMemoryStorageBackend(),
      jsonRpcUrl: fakeCcu.jsonRpcUrl,
      fetchInitialValues: false,
      now: () => clock,
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
    await central.start();
    const management = central.getManagement();
    await expect(management.serviceMessages()).resolves.toEqual([]);
    const servedBefore = fakeCcu.serviceMessageScriptCount;

    // 1. The CCU reboots: XML-RPC down, WebUI 503, every session wiped.
    fakeCcu.reboot();

    // 2. ReGa calls keep coming; each opens the next login window. Twelve
    //    calls = one failed renew + eleven failed logins.
    const loginsBefore = fakeCcu.loginRequestCount;
    for (let i = 0; i < 12; i += 1) {
      clock += 300_000;
      await expect(management.serviceMessages()).rejects.toBeInstanceOf(CcuManagementError);
    }
    expect(fakeCcu.loginRequestCount - loginsBefore).toBeGreaterThan(10);

    // Inside the window nothing is sent and the error says when the next try is.
    const gated = await management.serviceMessages().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(gated instanceof CcuManagementError ? gated.original : gated).toBeInstanceOf(
      LoginBackoffError,
    );

    // 3. The CCU comes back while the connection check runs its recovery.
    central.eventBus.subscribe({
      type: 'recoveryStageChanged',
      handler: (event) => {
        if (event.stage === RecoveryStage.TCP_CHECKING) fakeCcu.finishBoot();
      },
    });
    await central.connectionCheck();

    // 4. Same clock (still inside the old window), same central, same
    //    management object: re-inited, logged in, ReGa answers.
    expect(fakeCcu.lastRegistration?.interfaceId).toBe(INTERFACE_ID);
    await expect(management.serviceMessages()).resolves.toEqual([]);
    expect(fakeCcu.serviceMessageScriptCount).toBe(servedBefore + 1);
    expect(central.getConnectionInfo(INTERFACE_ID)?.state).toBe('CONNECTED');
  });
});
