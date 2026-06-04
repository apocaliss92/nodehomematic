/**
 * Unit tests for the initial-value seeding on {@link CentralUnit} (Fix B):
 *  - a debug summary is logged when values are seeded,
 *  - a channel whose `getParamset(VALUES)` throws is tolerated (best-effort:
 *    start() must not abort), and the other channels still seed.
 *
 * A stub InterfaceClient serves discovery and lets one channel fail on
 * `getParamset`; a logger spy captures the debug summary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CentralUnit } from '../../../src/central/central-unit.js';
import type { InterfaceClient } from '../../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Interface, ParamsetKey } from '../../../src/support/constants.js';
import { makeDpk } from '../../../src/support/dpk.js';
import type { DeviceDescription, ParameterData } from '../../../src/transport/xmlrpc/types.js';

const CENTRAL_NAME = 'TestCCU';
const INTERFACE_ID = 'TestCCU-HmIP-RF';

const DEVICES: readonly DeviceDescription[] = [
  { ADDRESS: 'VCU1', TYPE: 'HmIP-SWDO', PARAMSETS: ['MASTER'], CHILDREN: ['VCU1:1', 'VCU1:2'] },
  { ADDRESS: 'VCU1:1', TYPE: 'SWITCH', PARENT: 'VCU1', PARAMSETS: ['VALUES'] },
  { ADDRESS: 'VCU1:2', TYPE: 'SWITCH', PARENT: 'VCU1', PARAMSETS: ['VALUES'] },
];

const PARAMSETS: Readonly<Record<string, Record<string, ParameterData>>> = {
  'VCU1:1|VALUES': { STATE: { TYPE: 'BOOL', OPERATIONS: 1 | 2 | 4, FLAGS: 1 } },
  'VCU1:2|VALUES': { STATE: { TYPE: 'BOOL', OPERATIONS: 1 | 2 | 4, FLAGS: 1 } },
};

/** Stub InterfaceClient: serves discovery; channel `VCU1:2` faults on getParamset. */
class StubClient {
  public constructor(private readonly id: string) {}
  public get interfaceId(): string {
    return this.id;
  }
  public initProxy(): Promise<void> {
    return Promise.resolve();
  }
  public deinitProxy(): Promise<void> {
    return Promise.resolve();
  }
  public listDevices(): Promise<DeviceDescription[]> {
    return Promise.resolve([...DEVICES]);
  }
  public getParamsetDescription(
    channelAddress: string,
    paramsetKey: ParamsetKey,
  ): Promise<Record<string, ParameterData>> {
    return Promise.resolve(PARAMSETS[`${channelAddress}|${paramsetKey}`] ?? {});
  }
  public getParamset(channelAddress: string): Promise<Record<string, unknown>> {
    if (channelAddress === 'VCU1:2') {
      return Promise.reject(new Error('channel does not support getParamset VALUES'));
    }
    return Promise.resolve({ STATE: true });
  }
  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

describe('CentralUnit initial-value seeding', () => {
  let stub: StubClient;
  let debugMessages: string[];
  let central: CentralUnit;

  beforeEach(() => {
    stub = new StubClient(INTERFACE_ID);
    debugMessages = [];
    central = new CentralUnit({
      centralName: CENTRAL_NAME,
      host: '127.0.0.1',
      interfaces: [Interface.HMIP_RF],
      callback: { host: '127.0.0.1', port: 0 },
      storageBackend: new InMemoryStorageBackend(),
      makeInterfaceClient: () => stub as unknown as InterfaceClient,
      timings: { connectionCheckMs: 60_000, valueRefreshMs: 60_000 },
      tcpProbe: () => Promise.resolve(true),
      recoverySleep: () => Promise.resolve(),
      logger: { debug: (m) => debugMessages.push(m) },
    });
  });

  afterEach(async () => {
    await central.stop();
  });

  it('seeds the working channel, tolerates the failing one, and logs a summary', async () => {
    await central.start();

    // VCU1:1 seeded its STATE; VCU1:2 faulted and was skipped (no throw).
    expect(central.getValue(makeDpk(INTERFACE_ID, 'VCU1:1', 'VALUES', 'STATE'))).toBe(true);
    expect(central.getValue(makeDpk(INTERFACE_ID, 'VCU1:2', 'VALUES', 'STATE'))).toBeUndefined();

    // Exactly one value was seeded → a debug summary was logged.
    expect(debugMessages.some((m) => m.includes('seeded 1 initial value'))).toBe(true);
  });
});
