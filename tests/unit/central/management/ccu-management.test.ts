/**
 * {@link CcuManagement}: interfaces & radio health, service messages, CCU info
 * and heating groups, against a fake JSON-RPC client and fake interface clients.
 */
import { describe, it, expect } from 'vitest';
import {
  CcuManagement,
  type ManagementInterfaceClient,
} from '../../../../src/central/management/ccu-management.js';
import {
  ACKNOWLEDGE_SERVICE_MESSAGE,
  GET_CCU_PLATFORM,
  GET_SERVICE_MESSAGES,
} from '../../../../src/central/rega/scripts.js';
import { Interface } from '../../../../src/support/constants.js';
import { CcuManagementError, ValidationError } from '../../../../src/support/errors.js';
import { JsonRpcMethod } from '../../../../src/transport/jsonrpc/methods.js';
import type { RegaPostClient } from '../../../../src/central/rega/rega-runner.js';

interface Post {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
  readonly sessionId: string | undefined;
}

type Handler = (post: Post) => unknown;

function makeJson(handler: Handler): { client: RegaPostClient; posts: Post[] } {
  const posts: Post[] = [];
  const client: RegaPostClient = {
    post: (method, params, opts) => {
      const post: Post = { method, params, sessionId: opts?.sessionId };
      posts.push(post);
      try {
        return Promise.resolve(handler(post));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { client, posts };
}

function fakeIface(over: Partial<ManagementInterfaceClient> = {}): ManagementInterfaceClient {
  return {
    listBidcosInterfaces: () => Promise.resolve([]),
    setInstallMode: () => Promise.resolve(),
    getInstallModeRemaining: () => Promise.resolve(0),
    ...over,
  };
}

function build(opts: {
  json?: RegaPostClient | undefined;
  clients?: Partial<Record<Interface, ManagementInterfaceClient>>;
  configured?: Interface[];
}): CcuManagement {
  return new CcuManagement({
    json: opts.json,
    getSessionId: () => Promise.resolve('sid-1'),
    interfaceClient: (iface) => opts.clients?.[iface],
    configuredInterfaces: () => opts.configured ?? Object.keys(opts.clients ?? {}).map(toIface),
  });
}

function toIface(name: string): Interface {
  const found = Object.values(Interface).find((v) => v === name);
  if (found === undefined) throw new Error(`bad interface ${name}`);
  return found;
}

describe('CcuManagement.listInterfaces', () => {
  it('merges JSON listInterfaces, per-interface gateways and duty cycles (OpenCCU probe shape)', async () => {
    const { client, posts } = makeJson((p) => {
      if (p.method === JsonRpcMethod.INTERFACE_LIST_INTERFACES) {
        return [
          { name: 'BidCos-RF', port: 32001, info: 'BidCos-RF' },
          { name: 'VirtualDevices', port: 39292, info: 'Virtual' },
          { name: 'HmIP-RF', port: 32010, info: 'HmIP-RF' },
        ];
      }
      if (p.method === JsonRpcMethod.INTERFACE_IS_PRESENT) {
        return p.params?.['interface'] !== 'VirtualDevices';
      }
      throw new Error(`unexpected ${p.method}`);
    });
    const mgmt = build({
      json: client,
      clients: {
        [Interface.BIDCOS_RF]: fakeIface({
          listBidcosInterfaces: () =>
            Promise.resolve([
              {
                address: 'KEQ0000001',
                description: 'Local radio',
                dutyCycle: 7,
                connected: true,
                isDefault: true,
                firmware: '4.4.18',
                type: 'CCU3',
              },
            ]),
        }),
        [Interface.HMIP_RF]: fakeIface({
          listBidcosInterfaces: () =>
            Promise.resolve([
              {
                address: '3014F711A0000001',
                description: 'HmIP radio',
                dutyCycle: 31,
                connected: true,
                isDefault: false,
                firmware: '2.8.6',
                type: 'HMIP',
              },
            ]),
        }),
      },
    });
    const list = await mgmt.listInterfaces();
    expect(list.map((i) => i.port)).toEqual([32001, 39292, 32010]);
    expect(list.find((i) => i.name === 'BidCos-RF')).toMatchObject({
      connected: true,
      dutyCycle: 7,
      firmware: '4.4.18',
    });
    const hmip = list.find((i) => i.name === 'HmIP-RF');
    expect(hmip).toMatchObject({ connected: true, dutyCycle: 31, firmware: '2.8.6', type: 'HMIP' });
    expect(hmip?.gateways).toHaveLength(1);
    expect(list.find((i) => i.name === 'VirtualDevices')).toMatchObject({
      connected: false,
      dutyCycle: null,
    });
    expect(posts.every((p) => p.sessionId === 'sid-1')).toBe(true);
  });

  it('falls back to getDutyCycle (string "7") for BidCos-RF only, never attributing it to HmIP', async () => {
    const { client } = makeJson((p) => {
      if (p.method === JsonRpcMethod.INTERFACE_LIST_INTERFACES) {
        return [
          { name: 'BidCos-RF', port: 32001, info: 'BidCos-RF' },
          { name: 'HmIP-RF', port: 32010, info: 'HmIP-RF' },
        ];
      }
      if (p.method === JsonRpcMethod.INTERFACE_GET_DUTY_CYCLE) {
        return [{ address: 'KEQ0000001', dutyCycle: '7', type: 'CCU3' }];
      }
      if (p.method === JsonRpcMethod.INTERFACE_IS_PRESENT) return true;
      throw new Error(`unexpected ${p.method}`);
    });
    const list = await build({
      json: client,
      clients: { [Interface.BIDCOS_RF]: fakeIface(), [Interface.HMIP_RF]: fakeIface() },
    }).listInterfaces();
    expect(list.find((i) => i.name === 'BidCos-RF')?.dutyCycle).toBe(7);
    expect(list.find((i) => i.name === 'HmIP-RF')?.dutyCycle).toBeNull();
  });

  it('a non-numeric getDutyCycle value is null, never 0', async () => {
    const { client } = makeJson((p) => {
      if (p.method === JsonRpcMethod.INTERFACE_LIST_INTERFACES) {
        return [{ name: 'BidCos-RF', port: 32001, info: 'BidCos-RF' }];
      }
      if (p.method === JsonRpcMethod.INTERFACE_GET_DUTY_CYCLE) {
        return [{ address: 'KEQ0000001', dutyCycle: 'n/a', type: 'CCU3' }];
      }
      if (p.method === JsonRpcMethod.INTERFACE_IS_PRESENT) return true;
      throw new Error(`unexpected ${p.method}`);
    });
    const [bidcos] = await build({
      json: client,
      clients: { [Interface.BIDCOS_RF]: fakeIface() },
    }).listInterfaces();
    expect(bidcos?.dutyCycle).toBeNull();
  });

  it('reports null (never 0) when the duty-cycle / presence calls fail', async () => {
    const { client } = makeJson((p) => {
      if (p.method === JsonRpcMethod.INTERFACE_LIST_INTERFACES) {
        return [{ name: 'HmIP-RF', port: 2010, info: 'HmIP-RF' }];
      }
      throw new Error('method not found');
    });
    const mgmt = build({ json: client, clients: { [Interface.HMIP_RF]: fakeIface() } });
    const [hmip] = await mgmt.listInterfaces();
    expect(hmip).toMatchObject({ name: 'HmIP-RF', connected: null, dutyCycle: null });
  });

  it('without a JSON-RPC client falls back to the configured interfaces, all unknowns null', async () => {
    const mgmt = build({
      json: undefined,
      clients: { [Interface.HMIP_RF]: fakeIface() },
    });
    const list = await mgmt.listInterfaces();
    expect(list).toEqual([
      expect.objectContaining({
        name: 'HmIP-RF',
        port: null,
        info: null,
        connected: null,
        dutyCycle: null,
        gateways: [],
      }),
    ]);
  });
});

describe('CcuManagement install mode', () => {
  it('routes to the configured interface client', async () => {
    const seen: unknown[] = [];
    const mgmt = build({
      clients: {
        [Interface.HMIP_RF]: fakeIface({
          setInstallMode: (req) => {
            seen.push(req);
            return Promise.resolve();
          },
          getInstallModeRemaining: () => Promise.resolve(55),
        }),
      },
    });
    await mgmt.setInstallMode({ interface: 'HmIP-RF', on: true, seconds: 120 });
    expect(seen).toEqual([{ on: true, seconds: 120 }]);
    await expect(mgmt.getInstallMode('HmIP-RF')).resolves.toBe(55);
  });

  it('defaults to 60 s when switching on and rejects out-of-range seconds', async () => {
    const seen: unknown[] = [];
    const mgmt = build({
      clients: {
        [Interface.BIDCOS_RF]: fakeIface({
          setInstallMode: (req) => {
            seen.push(req);
            return Promise.resolve();
          },
        }),
      },
    });
    await mgmt.setInstallMode({ interface: 'BidCos-RF', on: true });
    expect(seen).toEqual([{ on: true, seconds: 60 }]);
    await expect(
      mgmt.setInstallMode({ interface: 'BidCos-RF', on: true, seconds: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      mgmt.setInstallMode({ interface: 'BidCos-RF', on: true, seconds: 100000 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('maps mode normal/secure to 1/2 and rejects an unknown or unconfigured interface', async () => {
    const seen: unknown[] = [];
    const mgmt = build({
      clients: {
        [Interface.BIDCOS_RF]: fakeIface({
          setInstallMode: (req) => {
            seen.push(req);
            return Promise.resolve();
          },
        }),
      },
    });
    await mgmt.setInstallMode({ interface: 'BidCos-RF', on: true, seconds: 30, mode: 'secure' });
    expect(seen).toEqual([{ on: true, seconds: 30, mode: 2 }]);
    await expect(mgmt.getInstallMode('HmIP-RF')).rejects.toBeInstanceOf(ValidationError);
    await expect(mgmt.getInstallMode('Nope')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('CcuManagement service messages', () => {
  it('parses the ReGa listing into typed messages', async () => {
    const { client, posts } = makeJson(() =>
      JSON.stringify([
        {
          id: 1234,
          name: 'Front%20Door',
          address: 'NEQ0001:0',
          type: 'UNREACH',
          timestamp: 1_700_000_000,
          acknowledgeable: false,
        },
        {
          id: 1235,
          name: '',
          address: 'NEQ0002:0',
          type: 'STICKY_UNREACH',
          timestamp: 0,
          acknowledgeable: true,
        },
        { id: 1236, name: '', address: '', type: '', timestamp: 0, acknowledgeable: true },
      ]),
    );
    const mgmt = build({ json: client });
    const messages = await mgmt.serviceMessages();
    expect(posts[0]?.params?.['script']).toBe(GET_SERVICE_MESSAGES);
    expect(messages).toEqual([
      {
        id: '1234',
        name: 'Front Door',
        address: 'NEQ0001',
        channel: 0,
        type: 'UNREACH',
        timestamp: 1_700_000_000_000,
        acknowledgeable: false,
      },
      {
        id: '1235',
        name: null,
        address: 'NEQ0002',
        channel: 0,
        type: 'STICKY_UNREACH',
        timestamp: null,
        acknowledgeable: true,
      },
      {
        id: '1236',
        name: null,
        address: null,
        channel: null,
        type: null,
        timestamp: null,
        acknowledgeable: true,
      },
    ]);
  });

  it('acknowledge validates the id, runs the ReGa receipt and reports a missing message', async () => {
    const { client, posts } = makeJson(() => JSON.stringify({ ok: true }));
    const mgmt = build({ json: client });
    await mgmt.acknowledgeServiceMessage('1235');
    expect(posts[0]?.params?.['script']).toBe(
      ACKNOWLEDGE_SERVICE_MESSAGE.split('##id##').join('1235'),
    );
    await expect(mgmt.acknowledgeServiceMessage('12; drop')).rejects.toBeInstanceOf(
      ValidationError,
    );
    const missing = makeJson(() => JSON.stringify({ ok: false }));
    await expect(
      build({ json: missing.client }).acknowledgeServiceMessage('9'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('needs a JSON-RPC client', async () => {
    await expect(build({}).serviceMessages()).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('CcuManagement.ccuInfo', () => {
  it('combines CCU.getVersion, CCU.getSerial and the platform script', async () => {
    const { client } = makeJson((p) => {
      if (p.method === JsonRpcMethod.CCU_GET_VERSION) return '3.89.11.20260919';
      if (p.method === JsonRpcMethod.CCU_GET_SERIAL) return 'ABC1234567';
      if (p.method === JsonRpcMethod.REGA_RUN_SCRIPT) {
        expect(p.params?.['script']).toBe(GET_CCU_PLATFORM);
        return JSON.stringify({
          release: 'VERSION=3.89.11.20260919%0APRODUCT=ova%0APLATFORM=ova%0A',
          host: 'raspberrymatic%0A',
        });
      }
      throw new Error('unexpected');
    });
    await expect(build({ json: client }).ccuInfo()).resolves.toEqual({
      version: '3.89.11.20260919',
      product: 'ova',
      productFamily: 'openccu',
      platform: 'ova',
      serial: 'ABC1234567',
      hostname: 'raspberrymatic',
    });
  });

  it('turns an unanswered field into null and fails only when nothing answered', async () => {
    const partial = makeJson((p) => {
      if (p.method === JsonRpcMethod.CCU_GET_VERSION) return '3.75.7';
      throw new Error('nope');
    });
    await expect(build({ json: partial.client }).ccuInfo()).resolves.toEqual({
      version: '3.75.7',
      product: null,
      productFamily: 'unknown',
      platform: null,
      serial: null,
      hostname: null,
    });
    const none = makeJson(() => {
      throw new Error('down');
    });
    await expect(build({ json: none.client }).ccuInfo()).rejects.toBeInstanceOf(CcuManagementError);
  });
});

describe('CcuManagement.groups', () => {
  const GSON = JSON.stringify({
    groups: [
      {
        id: 1,
        groupMembers: [
          { memberType: { id: 'WALLMOUNTED_THERMOSTAT' }, properties: {}, id: '000A9D89A7AF25:1' },
          { memberType: { id: 'HEATING_THERMOSTAT' }, properties: {}, id: '000A9D89A7AF26:1' },
        ],
        groupType: { id: 'hmip.heating.group', label: 'HmIP-Heizungssteuerung', version: 131072 },
        groupProperties: {
          FORBID_SINGLE_OPERATION: false,
          GROUP_DEVICE_NAME: 'Heizung Flur INT0000001',
          NAME: 'Heizung Flur',
        },
      },
      {
        id: 2,
        groupMembers: [],
        groupType: { id: 'HomeMatic.heating' },
        groupProperties: { NAME: 'Wohnzimmer' },
      },
    ],
  });

  it('parses CCU.getHeatingGroupList (a JSON string)', async () => {
    const { client, posts } = makeJson(() => GSON);
    const groups = await build({ json: client }).groups();
    expect(posts[0]?.method).toBe(JsonRpcMethod.CCU_GET_HEATING_GROUP_LIST);
    expect(groups).toEqual([
      {
        id: 1,
        name: 'Heizung Flur',
        type: 'hmip.heating.group',
        typeLabel: 'HmIP-Heizungssteuerung',
        deviceAddress: 'INT0000001',
        forbidSingleOperation: false,
        members: [
          { address: '000A9D89A7AF25:1', type: 'WALLMOUNTED_THERMOSTAT' },
          { address: '000A9D89A7AF26:1', type: 'HEATING_THERMOSTAT' },
        ],
      },
      {
        id: 2,
        name: 'Wohnzimmer',
        type: 'HomeMatic.heating',
        typeLabel: null,
        deviceAddress: null,
        forbidSingleOperation: false,
        members: [],
      },
    ]);
  });

  it('returns [] when the CCU has no groups file (-1 / empty), and throws on a transport fault', async () => {
    expect(await build({ json: makeJson(() => -1).client }).groups()).toEqual([]);
    expect(await build({ json: makeJson(() => '').client }).groups()).toEqual([]);
    const bad = makeJson(() => {
      throw new Error('boom');
    });
    await expect(build({ json: bad.client }).groups()).rejects.toBeInstanceOf(CcuManagementError);
  });
});
