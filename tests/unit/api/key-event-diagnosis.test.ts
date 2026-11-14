import { describe, it, expect } from 'vitest';
import {
  diagnoseKeyEvents,
  type KeyDiagnosisSource,
} from '../../../src/api/key-event-diagnosis.js';
import { CcuKeyDiagnosis } from '../../../src/central/management/ccu-key-diagnosis.js';
import { buildDiagnoseKeyEvents } from '../../../src/central/rega/key-diagnosis.js';
import { runScript, type RegaPostClient } from '../../../src/central/rega/rega-runner.js';
import { ModelChannel } from '../../../src/model/channel.js';
import { ModelDevice } from '../../../src/model/device.js';
import { GenericDataPoint } from '../../../src/model/data-point.js';
import type { ParameterSpec } from '../../../src/central/graph.js';
import { ClientState } from '../../../src/transport/resilience/state-machine.js';
import { makeDpk } from '../../../src/support/dpk.js';
import { Operations, ParameterType, ParamsetKey } from '../../../src/support/constants.js';
import { ValidationError } from '../../../src/support/errors.js';
import type { XmlRpcValue } from '../../../src/transport/xmlrpc/types.js';

const IFACE_ID = 'CCU-HmIP-RF';
const DEV = '00315F298E5093';
const SPEC: ParameterSpec = {
  type: ParameterType.ACTION,
  operations: Operations.READ | Operations.EVENT,
  flags: 1,
  readable: true,
  writable: false,
  hasEvents: true,
  visible: true,
};

function dp(channel: string, parameter: string, at?: number): GenericDataPoint {
  const point = new GenericDataPoint({
    dpk: makeDpk(IFACE_ID, channel, 'VALUES', parameter),
    spec: SPEC,
    interfaceFamily: 'HMIP',
  });
  if (at !== undefined) point.applyCcuValue(true, at);
  return point;
}

function device(): ModelDevice {
  return new ModelDevice({
    address: DEV,
    type: 'HmIP-BS2',
    interfaceId: IFACE_ID,
    channels: [
      new ModelChannel({
        address: `${DEV}:0`,
        index: 0,
        type: 'MAINTENANCE',
        dataPoints: [dp(`${DEV}:0`, 'RSSI_DEVICE', 5_000)],
      }),
      new ModelChannel({
        address: `${DEV}:1`,
        index: 1,
        type: 'KEY_TRANSCEIVER',
        dataPoints: [dp(`${DEV}:1`, 'PRESS_SHORT', 1_000), dp(`${DEV}:1`, 'PRESS_LONG')],
      }),
      new ModelChannel({
        address: `${DEV}:2`,
        index: 2,
        type: 'KEY_TRANSCEIVER',
        dataPoints: [],
      }),
      new ModelChannel({
        address: `${DEV}:3`,
        index: 3,
        type: 'SWITCH_TRANSMITTER',
        dataPoints: [],
      }),
    ],
  });
}

interface Calls {
  readonly metadata: string[];
  readonly links: string[];
  readonly paramsets: string[];
}

function source(overrides: Partial<KeyDiagnosisSource> = {}): {
  src: KeyDiagnosisSource;
  calls: Calls;
} {
  const calls: Calls = { metadata: [], links: [], paramsets: [] };
  const src: KeyDiagnosisSource = {
    getMetadata: (_i, address): Promise<XmlRpcValue> => {
      calls.metadata.push(address);
      return Promise.resolve({ PRESS_SHORT: 1 });
    },
    getLinks: (_i, address): Promise<XmlRpcValue> => {
      calls.links.push(address);
      return Promise.resolve([]);
    },
    readParamset: (_i, address, key) => {
      calls.paramsets.push(`${address}/${key}`);
      return Promise.resolve(
        address.endsWith(':0') && key === ParamsetKey.VALUES
          ? { CONFIG_PENDING: false, UNREACH: false, RSSI_DEVICE: -61, RSSI_PEER: -58 }
          : { MARK: `${address}/${key}` },
      );
    },
    getParamsetSpec: () => undefined,
    getConnectionInfo: () => ({
      state: ClientState.CONNECTED,
      lastEventAt: 9_000,
      callbackAlive: true,
    }),
    readRega: () => Promise.reject(new ValidationError('needs WebUI credentials')),
    now: () => 42,
    ...overrides,
  };
  return { src, calls };
}

/** A ReGa runner backed by a fake JSON-RPC poster that records the script and answers `answer`. */
function regaWith(answer: unknown): { read: KeyDiagnosisSource['readRega']; scripts: string[] } {
  const scripts: string[] = [];
  const client: RegaPostClient = {
    post: (_method, params) => {
      const script = params?.['script'];
      if (typeof script === 'string') scripts.push(script);
      return Promise.resolve(JSON.stringify(answer));
    },
  };
  const service = new CcuKeyDiagnosis((_label, script, params) =>
    runScript(client, 'sid', script, params),
  );
  return { read: (iface, addresses) => service.read(iface, addresses), scripts };
}

const REGA_ANSWER = {
  channels: [
    {
      address: `${DEV}:1`,
      found: true,
      id: '4711',
      name: 'Hall%20key%3A1',
      visible: 'true',
      enabled: 'true',
      readyConfig: 'true',
      lastActionSeconds: '1700000100',
      datapoints: [
        {
          name: `HmIP-RF.${DEV}:1.PRESS_SHORT`,
          exists: true,
          id: '4712',
          value: 'false',
          timestampSeconds: '1700000100',
          lastTimestampSeconds: '1700000000',
        },
        { name: `HmIP-RF.${DEV}:1.PRESS_LONG`, exists: false },
      ],
    },
    { address: `${DEV}:2`, found: false, datapoints: [] },
  ],
  programs: [
    {
      id: '900',
      name: 'Key%20events',
      active: 'true',
      internal: 'false',
      lastExecuteSeconds: '0',
      datapoints: [`HmIP-RF.${DEV}:1.PRESS_SHORT`],
    },
  ],
};

describe('diagnoseKeyEvents', () => {
  it('collects XML-RPC, ReGa and client state for every key channel (happy path)', async () => {
    const rega = regaWith(REGA_ANSWER);
    const { src, calls } = source({ readRega: rega.read });
    const result = await diagnoseKeyEvents(src, device());

    expect(result.deviceAddress).toBe(DEV);
    expect(result.takenAt).toBe(42);
    // Key channels only: :1 and :2, not the maintenance channel nor :3.
    expect(result.channels.map((c) => c.address)).toEqual([`${DEV}:1`, `${DEV}:2`]);
    expect(calls.metadata).toEqual([`${DEV}:1`, `${DEV}:2`]);
    expect(calls.links).toEqual([`${DEV}:1`, `${DEV}:2`]);
    const first = result.channels[0];
    expect(first?.type).toBe('KEY_TRANSCEIVER');
    expect(first?.xmlRpc.centralLink).toEqual({
      ok: true,
      data: { pressShortCount: 1, active: true },
    });
    expect(first?.xmlRpc.directLinks).toEqual({ ok: true, data: [] });
    expect(first?.xmlRpc.values).toEqual({ ok: true, data: { MARK: `${DEV}:1/VALUES` } });
    expect(first?.xmlRpc.master).toEqual({ ok: true, data: { MARK: `${DEV}:1/MASTER` } });
    expect(result.maintenance).toEqual({
      ok: true,
      data: {
        channelAddress: `${DEV}:0`,
        configPending: false,
        unreach: false,
        rssiDevice: -61,
        rssiPeer: -58,
        updatePending: null,
      },
    });
    // Client side: PRESS_SHORT arrived at 1000, PRESS_LONG never, PRESS_LONG_RELEASE has no data point.
    expect(first?.client.parameters).toEqual([
      { parameter: 'PRESS_SHORT', known: true, lastEventAt: 1_000, value: true },
      { parameter: 'PRESS_LONG', known: true, lastEventAt: null, value: null },
      { parameter: 'PRESS_LONG_RELEASE', known: false, lastEventAt: null, value: null },
    ]);
    expect(result.maintenanceClient.parameters).toEqual([
      { parameter: 'RSSI_DEVICE', known: true, lastEventAt: 5_000, value: true },
    ]);
    expect(result.interfaceClient).toEqual({
      interfaceId: IFACE_ID,
      state: ClientState.CONNECTED,
      lastEventAt: 9_000,
      callbackAlive: true,
    });
    // ReGa: names decoded, seconds -> ms, a zero time is null.
    expect(result.rega.available).toBe(true);
    if (!result.rega.available) throw new Error('rega unavailable');
    const ch = result.rega.state.channels[0];
    expect(ch).toMatchObject({
      found: true,
      id: '4711',
      name: 'Hall key:1',
      visible: true,
      enabled: true,
      readyConfig: true,
      lastActionAt: 1_700_000_100_000,
    });
    expect(ch?.datapoints[0]).toEqual({
      name: `HmIP-RF.${DEV}:1.PRESS_SHORT`,
      exists: true,
      id: '4712',
      value: 'false',
      timestamp: 1_700_000_100_000,
      lastTimestamp: 1_700_000_000_000,
    });
    expect(result.rega.state.channels[1]?.found).toBe(false);
    expect(result.rega.state.programs).toEqual([
      {
        id: '900',
        name: 'Key events',
        active: true,
        internal: false,
        lastExecutedAt: null,
        datapoints: [`HmIP-RF.${DEV}:1.PRESS_SHORT`],
      },
    ]);
    // The one script covers both key channels on the HmIP-RF interface.
    expect(rega.scripts).toHaveLength(1);
    expect(rega.scripts[0]).toContain(`dom.GetObject("HmIP-RF.${DEV}:2.PRESS_LONG_RELEASE")`);
  });

  it('reports rega unavailable, with the reason, when ReGa cannot be read', async () => {
    const { src } = source();
    const result = await diagnoseKeyEvents(src, device());
    expect(result.rega).toEqual({ available: false, reason: 'needs WebUI credentials' });
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]?.xmlRpc.values.ok).toBe(true);
  });

  it('reports a missing data point and no referencing program', async () => {
    const rega = regaWith({
      channels: [
        {
          address: `${DEV}:1`,
          found: true,
          id: '1',
          name: 'k',
          visible: 'true',
          enabled: '',
          readyConfig: 'false',
          lastActionSeconds: '0',
          datapoints: [{ name: `HmIP-RF.${DEV}:1.PRESS_SHORT`, exists: false }],
        },
      ],
      programs: [],
    });
    const { src } = source({ readRega: rega.read });
    const result = await diagnoseKeyEvents(src, device());
    if (!result.rega.available) throw new Error('rega unavailable');
    expect(result.rega.state.programs).toEqual([]);
    const point = result.rega.state.channels[0]?.datapoints[0];
    expect(point).toEqual({
      name: `HmIP-RF.${DEV}:1.PRESS_SHORT`,
      exists: false,
      id: null,
      value: null,
      timestamp: null,
      lastTimestamp: null,
    });
    // Empty answers are unknown, not false.
    expect(result.rega.state.channels[0]?.enabled).toBeNull();
    expect(result.rega.state.channels[0]?.lastActionAt).toBeNull();
  });

  it('a failing section does not abort the others', async () => {
    const { src } = source({
      getMetadata: () => Promise.reject(new Error('metadata fault')),
      readParamset: (_i, address, key) =>
        key === ParamsetKey.MASTER && address === `${DEV}:1`
          ? Promise.reject(new Error('master fault'))
          : Promise.resolve({ OK: 1 }),
    });
    const result = await diagnoseKeyEvents(src, device());
    const first = result.channels[0];
    expect(first?.xmlRpc.centralLink).toEqual({ ok: false, error: 'metadata fault' });
    expect(first?.xmlRpc.master).toEqual({ ok: false, error: 'master fault' });
    expect(first?.xmlRpc.values).toEqual({ ok: true, data: { OK: 1 } });
    expect(first?.xmlRpc.directLinks.ok).toBe(true);
    expect(result.channels[1]?.xmlRpc.master).toEqual({ ok: true, data: { OK: 1 } });
    expect(result.maintenance.ok).toBe(true);
  });

  it('finds a key channel by its PRESS_SHORT paramset description when the type is unknown', async () => {
    const dev = new ModelDevice({
      address: DEV,
      type: 'X',
      interfaceId: IFACE_ID,
      channels: [new ModelChannel({ address: `${DEV}:4`, index: 4, dataPoints: [] })],
    });
    const { src } = source({
      getParamsetSpec: (_i, address) =>
        address === `${DEV}:4`
          ? { PRESS_SHORT: { TYPE: 'ACTION', OPERATIONS: 4, FLAGS: 1 } }
          : undefined,
    });
    const result = await diagnoseKeyEvents(src, dev);
    expect(result.channels.map((c) => c.address)).toEqual([`${DEV}:4`]);
  });
});

describe('buildDiagnoseKeyEvents', () => {
  it('rejects an address or interface that could carry script text', () => {
    expect(() => buildDiagnoseKeyEvents('HmIP-RF', ['X:1"; dom.Foo(); "'])).toThrow(
      ValidationError,
    );
    expect(() => buildDiagnoseKeyEvents('HmIP-RF', ['X'])).toThrow(ValidationError);
    expect(() => buildDiagnoseKeyEvents('Hm"IP', ['X:1'])).toThrow(ValidationError);
  });

  it('only reads: no write calls in the script', () => {
    const script = buildDiagnoseKeyEvents('HmIP-RF', [`${DEV}:1`]);
    expect(script).not.toMatch(/\.(Name|Active|Internal|Enabled|ReadyConfig|Visible)\([^)]/);
    expect(script).not.toContain('CreateObject');
    expect(script).not.toContain('DeleteObject');
    expect(script).not.toContain('RTUpdate');
  });
});
