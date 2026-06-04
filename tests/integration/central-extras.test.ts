/**
 * Additional CentralUnit behaviours exercised against the {@link FakeCcu}:
 * MASTER-paramset setValue, the unknown-interface guard, the no-credentials
 * discovery path, cache-disabled, incremental `newDevices`, and value re-sync on
 * recovery. These round out coverage of the lifecycle paths not hit by the main
 * cycle/reconnect scenarios.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { Interface } from '../../src/support/constants.js';
import { makeDpk } from '../../src/support/dpk.js';
import { RecoveryStage } from '../../src/central/connection/recovery.js';
import type { CentralEvent } from '../../src/central/events.js';

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

function build(
  fakeCcu: FakeCcu,
  opts: { credentials?: boolean; cacheEnabled?: boolean; storage?: InMemoryStorageBackend } = {},
): { central: CentralUnit; events: CentralEvent[] } {
  const central: CentralUnit = new CentralUnit({
    centralName: CENTRAL_NAME,
    host: HOST,
    interfaces: [Interface.HMIP_RF],
    ...(opts.credentials === false
      ? {}
      : { credentials: { username: 'Admin', password: 'secret' } }),
    callback: { host: HOST, port: 0 },
    cache: { enabled: opts.cacheEnabled ?? true },
    ...(opts.storage ? { storageBackend: opts.storage } : {}),
    jsonClient: undefined,
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
  const events: CentralEvent[] = [];
  for (const type of ['ready', 'deviceAdded', 'devicesCreated'] as const) {
    central.eventBus.subscribe({ type, handler: (e) => void events.push(e) });
  }
  return { central, events };
}

describe('central extras (fake CCU)', () => {
  let fakeCcu: FakeCcu;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({ username: 'Admin', password: 'secret' });
    await fakeCcu.start();
  });

  afterEach(async () => {
    await fakeCcu.stop();
  });

  it('discovers without credentials (no JSON-RPC details merge)', async () => {
    const { central } = build(fakeCcu, { credentials: false });
    await central.start();
    const devices = central.devices();
    expect(devices).toHaveLength(1);
    // No JSON-RPC client → no merged name.
    expect(devices[0]!.name).toBeUndefined();
    await central.stop();
  });

  it('routes setValue for the MASTER paramset via putParamset', async () => {
    const { central } = build(fakeCcu, { credentials: false });
    await central.start();
    const dpk = makeDpk(INTERFACE_ID, 'VCU0000001:1', 'MASTER', 'CYCLIC_INFO_MSG');
    await central.setValue(dpk, true);
    expect(fakeCcu.storedValue('VCU0000001:1', 'CYCLIC_INFO_MSG')).toBe(true);
    await central.stop();
  });

  it('throws on setValue for an unknown interface', async () => {
    const { central } = build(fakeCcu, { credentials: false });
    await central.start();
    const dpk = makeDpk('Unknown-Iface', 'VCU0000001:1', 'VALUES', 'STATE');
    await expect(central.setValue(dpk, true)).rejects.toThrow(/unknown interface/);
    await central.stop();
  });

  it('does not persist when caching is disabled', async () => {
    const storage = new InMemoryStorageBackend();
    const { central } = build(fakeCcu, { credentials: false, cacheEnabled: false, storage });
    await central.start();
    await central.stop();
    expect(await storage.load('device_descriptions')).toBeNull();
  });

  it('incrementally adds a device on a newDevices callback', async () => {
    const { central, events } = build(fakeCcu, { credentials: false });
    await central.start();

    // Push a newDevices callback for the already-known device; discovery is
    // idempotent and re-emits the touched node.
    const reg = fakeCcu.lastRegistration!;
    await fakeCcu.emitNewDevices([{ ADDRESS: 'VCU0000001', TYPE: 'HmIP-SWDO' }]);
    void reg;

    await waitFor(() => events.some((e) => e.type === 'deviceAdded'));
    expect(events.some((e) => e.type === 'deviceAdded')).toBe(true);
    await central.stop();
  });

  it('start() is idempotent and stop() before start is a no-op', async () => {
    const { central } = build(fakeCcu, { credentials: false });
    await central.start();
    await central.start(); // second call returns immediately
    expect(central.devices()).toHaveLength(1);
    await central.stop();
    await central.stop(); // second stop is a no-op
  });

  it('runs with all real defaults (real clients, file cache, real TCP probe)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'central-'));
    try {
      // No injected makeInterfaceClient / jsonClient / tcpProbe — the real
      // builders run. interfacePorts points the real InterfaceClient and the
      // real TCP probe at the fake CCU's ephemeral port.
      const central: CentralUnit = new CentralUnit({
        centralName: 'RealCCU',
        host: HOST,
        interfaces: [Interface.HMIP_RF],
        credentials: { username: 'Admin', password: 'secret' },
        callback: { host: HOST, port: 0 },
        cache: { dir, enabled: true },
        interfacePorts: { [Interface.HMIP_RF]: fakeCcu.port },
        timings: { connectionCheckMs: 3_600_000, valueRefreshMs: 3_600_000 },
        // Keep the real builders/clients/TCP probe; only collapse the long
        // cooldown/warmup waits so the recovery exercise stays fast.
        recoverySleep: () => Promise.resolve(),
      });

      const stages: RecoveryStage[] = [];
      central.eventBus.subscribe({
        type: 'recoveryStageChanged',
        handler: (event) => {
          stages.push(event.stage as RecoveryStage);
          if (event.stage === RecoveryStage.TCP_CHECKING) fakeCcu.restore();
        },
      });

      await central.start();
      expect(central.devices()).toHaveLength(1);
      // The real JSON-RPC client + SessionManager were constructed (the WebUI
      // lives on a different port than the interface, so the details merge is a
      // best-effort no-op here — discovery still builds the graph).
      expect(central.devices()[0]!.address).toBe('VCU0000001');

      // Drive a real recovery: the default openTcp() probes the fake's real port
      // (reachable), the real listMethods() passes after restore.
      fakeCcu.dropConnection();
      await central.connectionCheck();
      await waitFor(() => stages[stages.length - 1] === RecoveryStage.RECOVERED, {
        timeoutMs: 8000,
      });

      await central.stop();
      // File cache was written to disk.
      const files = await readdir(dir);
      expect(files.some((f) => f.includes('device_descriptions'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
