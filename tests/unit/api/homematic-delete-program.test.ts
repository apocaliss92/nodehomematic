/** The facade's `deleteProgram` wired through a real CentralUnit with stub clients. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Homematic, createHomematicForTest } from '../../../src/api/homematic.js';
import { CentralUnit, type JsonRpcClientLike } from '../../../src/central/central-unit.js';
import type { InterfaceClient } from '../../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Interface } from '../../../src/support/constants.js';
import { ValidationError } from '../../../src/support/errors.js';
import { JsonRpcMethod } from '../../../src/transport/jsonrpc/methods.js';

class StubClient {
  public constructor(private readonly idValue: string) {}
  public get interfaceId(): string {
    return this.idValue;
  }
  public initProxy(): Promise<void> {
    return Promise.resolve();
  }
  public deinitProxy(): Promise<void> {
    return Promise.resolve();
  }
  public listDevices(): Promise<[]> {
    return Promise.resolve([]);
  }
  public getParamsetDescription(): Promise<Record<string, never>> {
    return Promise.resolve({});
  }
  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
  public listBidcosInterfaces(): Promise<[]> {
    return Promise.resolve([]);
  }
}

class RegaJson implements JsonRpcClientLike {
  public readonly scripts: string[] = [];
  public post(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === JsonRpcMethod.REGA_RUN_SCRIPT) {
      const script = params?.['script'];
      if (typeof script === 'string') this.scripts.push(script);
      return Promise.resolve('{"removed":true}');
    }
    return Promise.resolve([]);
  }
  public close(): Promise<void> {
    return Promise.resolve();
  }
}

async function started(json: RegaJson | undefined): Promise<Homematic> {
  const central = new CentralUnit({
    centralName: 'TestCCU',
    host: '127.0.0.1',
    interfaces: [Interface.HMIP_RF],
    ...(json !== undefined
      ? { credentials: { username: 'Admin', password: 'x' }, jsonClient: json }
      : {}),
    callback: { host: '127.0.0.1', port: 0 },
    storageBackend: new InMemoryStorageBackend(),
    makeInterfaceClient: () => new StubClient('TestCCU-HmIP-RF') as unknown as InterfaceClient,
    timings: { connectionCheckMs: 60_000, valueRefreshMs: 60_000 },
    tcpProbe: () => Promise.resolve(true),
    recoverySleep: () => Promise.resolve(),
    fetchInitialValues: false,
  });
  const hm = createHomematicForTest(
    { host: '127.0.0.1', interfaces: ['HmIP-RF'], callback: { host: '127.0.0.1', port: 0 } },
    { central },
  );
  await hm.start();
  return hm;
}

describe('Homematic.deleteProgram', () => {
  let hm: Homematic | undefined;
  afterEach(async () => {
    await hm?.stop();
    hm = undefined;
  });

  describe('with WebUI credentials', () => {
    let json: RegaJson;
    beforeEach(async () => {
      json = new RegaJson();
      hm = await started(json);
    });

    it('deletes the program id through ReGa and reports removed', async () => {
      await expect(hm?.deleteProgram('10655')).resolves.toEqual({ removed: true });
      const script = json.scripts.find((s) => s.includes('nodehomematic:deleteProgram'));
      expect(script).toContain('10655');
      expect(script).toContain('EnumUsedIDs()');
      expect(script).toContain('dom.DeleteObject');
    });

    it('rejects a non-digit id before ReGa', async () => {
      const before = json.scripts.length;
      await expect(hm?.deleteProgram('10655; x')).rejects.toBeInstanceOf(ValidationError);
      expect(json.scripts).toHaveLength(before);
      expect(json.scripts.some((s) => s.includes('nodehomematic:deleteProgram'))).toBe(false);
    });
  });

  it('refuses the call before start()', async () => {
    const idle = new Homematic({
      host: '127.0.0.1',
      interfaces: ['HmIP-RF'],
      callback: { host: '127.0.0.1', port: 0 },
    });
    await expect(idle.deleteProgram('1')).rejects.toBeInstanceOf(ValidationError);
  });
});
