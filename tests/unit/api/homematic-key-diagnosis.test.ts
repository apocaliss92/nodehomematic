/** The facade's `diagnoseKeyEvents` wired through a real CentralUnit with stub clients. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Homematic, createHomematicForTest } from '../../../src/api/homematic.js';
import { CentralUnit, type JsonRpcClientLike } from '../../../src/central/central-unit.js';
import type { InterfaceClient } from '../../../src/transport/interface-client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Interface } from '../../../src/support/constants.js';
import { ValidationError } from '../../../src/support/errors.js';
import { JsonRpcMethod } from '../../../src/transport/jsonrpc/methods.js';
import type { DeviceDescription } from '../../../src/transport/xmlrpc/types.js';

const DEVICES: readonly DeviceDescription[] = [
  { ADDRESS: 'VCU1', TYPE: 'HmIP-BS2', PARAMSETS: ['MASTER'], CHILDREN: ['VCU1:0', 'VCU1:1'] },
  { ADDRESS: 'VCU1:0', TYPE: 'MAINTENANCE', PARENT: 'VCU1', PARAMSETS: ['MASTER', 'VALUES'] },
  { ADDRESS: 'VCU1:1', TYPE: 'KEY_TRANSCEIVER', PARENT: 'VCU1', PARAMSETS: ['MASTER', 'VALUES'] },
];

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
  public listDevices(): Promise<DeviceDescription[]> {
    return Promise.resolve([...DEVICES]);
  }
  public getParamsetDescription(): Promise<Record<string, never>> {
    return Promise.resolve({});
  }
  public getParamset(address: string, key: string): Promise<Record<string, unknown>> {
    return Promise.resolve({ SEEN: `${address}/${key}`, UNREACH: false });
  }
  public getMetadata(): Promise<Record<string, number>> {
    return Promise.resolve({ PRESS_SHORT: 2 });
  }
  public getLinks(): Promise<[]> {
    return Promise.resolve([]);
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
  public answer: unknown = { channels: [], programs: [] };
  public post(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === JsonRpcMethod.REGA_RUN_SCRIPT) {
      const script = params?.['script'];
      if (typeof script === 'string') this.scripts.push(script);
      return Promise.resolve(JSON.stringify(this.answer));
    }
    return Promise.resolve([]);
  }
  public close(): Promise<void> {
    return Promise.resolve();
  }
}

async function facade(withCredentials: boolean, json: RegaJson): Promise<Homematic> {
  const central = new CentralUnit({
    centralName: 'TestCCU',
    host: '127.0.0.1',
    interfaces: [Interface.HMIP_RF],
    ...(withCredentials
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

describe('Homematic.diagnoseKeyEvents', () => {
  let hm: Homematic | undefined;
  afterEach(async () => {
    await hm?.stop();
    hm = undefined;
  });

  describe('with WebUI credentials', () => {
    let json: RegaJson;
    beforeEach(async () => {
      json = new RegaJson();
      hm = await facade(true, json);
    });

    it('reads the key channel over XML-RPC and ReGa', async () => {
      const result = await hm?.diagnoseKeyEvents('VCU1');
      expect(result?.channels.map((c) => c.address)).toEqual(['VCU1:1']);
      expect(result?.channels[0]?.xmlRpc.centralLink).toEqual({
        ok: true,
        data: { pressShortCount: 2, active: true },
      });
      expect(result?.maintenance.ok).toBe(true);
      expect(result?.rega).toEqual({ available: true, state: { channels: [], programs: [] } });
      const script = json.scripts.find((s) => s.includes('nodehomematic:diagnoseKeyEvents'));
      expect(script).toContain('HmIP-RF.VCU1:1.PRESS_SHORT');
    });

    it('rejects an unknown device', async () => {
      await expect(hm?.diagnoseKeyEvents('NOPE')).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('without credentials the XML-RPC part still answers and rega is unavailable', async () => {
    hm = await facade(false, new RegaJson());
    const result = await hm.diagnoseKeyEvents('VCU1');
    expect(result.channels).toHaveLength(1);
    expect(result.rega.available).toBe(false);
  });
});

describe('Homematic.keyProgramReferences', () => {
  let hm: Homematic | undefined;
  let json: RegaJson;
  beforeEach(async () => {
    json = new RegaJson();
    hm = await facade(true, json);
  });
  afterEach(async () => {
    await hm?.stop();
    hm = undefined;
  });

  it('lists a hand-written program by the key channel its condition references, in one script', async () => {
    json.answer = {
      programs: [
        {
          id: '4711',
          name: 'Klingel%20Dummy',
          active: 'true',
          internal: '',
          lastExecuteSeconds: '0',
          datapoints: ['HmIP-RF.VCU1:1.PRESS_SHORT', 'HmIP-RF.VCU1:1.PRESS_LONG'],
        },
      ],
    };
    const result = await hm?.keyProgramReferences(['VCU1:1']);
    expect(result).toEqual([
      { id: '4711', name: 'Klingel Dummy', active: true, channels: ['VCU1:1'] },
    ]);
    const scripts = json.scripts.filter((s) => s.includes('nodehomematic:keyProgramReferences'));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('HmIP-RF.VCU1:1.PRESS_LONG_RELEASE');
  });

  it('answers [] only when ReGa answered with no program, and throws on an unparseable answer', async () => {
    json.answer = { programs: [] };
    await expect(hm?.keyProgramReferences(['VCU1:1'])).resolves.toEqual([]);
    json.answer = 'garbage';
    await expect(hm?.keyProgramReferences(['VCU1:1'])).rejects.toThrow();
  });

  it('rejects an address of no known device', async () => {
    await expect(hm?.keyProgramReferences(['NOPE:1'])).rejects.toBeInstanceOf(ValidationError);
  });
});
