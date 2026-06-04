/**
 * Integration test for the Phase-5 hub surface of the {@link Homematic} facade
 * against an in-process {@link FakeCcu} — NO hardware, NO mocks of our own
 * modules. The facade builds a REAL CentralUnit (real InterfaceClient /
 * CallbackServer / JsonRpcClient / SessionManager / caches); only the transport
 * URLs + an in-memory storage backend are injected.
 *
 * Covers: start → systemVariables()/programs() populated with parsed values +
 * writable flags; setSystemVariable on the writable var reaches the CCU; on the
 * read-only var throws ValidationError (no write); runProgram reaches the CCU; a
 * device's rooms (in devices()) reflect the ReGa rooms script. Deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { Homematic, createHomematicForTest } from '../../src/api/homematic.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { Interface } from '../../src/support/constants.js';
import { ValidationError } from '../../src/support/errors.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
const CALLBACK_HOST = '127.0.0.1';

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
    {
      host: CALLBACK_HOST,
      interfaces: ['HmIP-RF'],
      callback: { host: CALLBACK_HOST, port: 0 },
    },
    { central },
  );
}

describe('hub cycle (fake CCU, real central + transport modules)', () => {
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

  it('populates systemVariables() with parsed values + writable flags', () => {
    const sysvars = hm.systemVariables();
    expect(sysvars).toHaveLength(2);

    const writable = sysvars.find((v) => v.name === fakeCcu.writableSysVarName)!;
    expect(writable.type).toBe('LOGIC');
    expect(writable.value).toBe(true);
    expect(writable.writable).toBe(true);

    const readonly = sysvars.find((v) => v.name === fakeCcu.readonlySysVarName)!;
    expect(readonly.type).toBe('FLOAT');
    expect(readonly.value).toBe(21.5);
    expect(readonly.unit).toBe('°C');
    expect(readonly.writable).toBe(false);
  });

  it('populates programs()', () => {
    const programs = hm.programs();
    expect(programs.map((p) => p.name).sort()).toEqual(['Goodnight', 'Wakeup']);
  });

  it('setSystemVariable on the writable var reaches the CCU', async () => {
    await hm.setSystemVariable(fakeCcu.writableSysVarName, false);
    // LOGIC → boolean → SysVar.setBool(0/1).
    expect(fakeCcu.sysVarWrite(fakeCcu.writableSysVarName)).toBe(0);
  });

  it('setSystemVariable on the read-only var throws ValidationError (no write)', async () => {
    await expect(hm.setSystemVariable(fakeCcu.readonlySysVarName, 30)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fakeCcu.sysVarWrite(fakeCcu.readonlySysVarName)).toBeUndefined();
  });

  it('runProgram (by name) reaches the CCU', async () => {
    await hm.runProgram(fakeCcu.programName);
    expect(fakeCcu.didExecuteProgram('30001')).toBe(true);
  });

  it("a device's rooms/functions reflect the ReGa rooms script", () => {
    const device = hm.devices().find((d) => d.address === 'VCU0000001')!;
    expect(device.rooms).toContain('Kitchen');
    expect(device.functions).toContain('Light');
  });
});
