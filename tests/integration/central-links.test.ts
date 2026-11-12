/**
 * Central links and channel names against an in-process {@link FakeCcu}.
 *
 * Covers: create → central true; a second create does not call again; remove
 * sends ref counter 0; direct links from getLinks; a refused reportValueUsage;
 * Device.listAllDetail names; a failed name read leaves the connection up and
 * names null.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { createHomematicForTest } from '../../src/api/homematic.js';
import type { Homematic } from '../../src/api/homematic.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { Interface } from '../../src/support/constants.js';
import { ClientError, ValidationError } from '../../src/support/errors.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
const CALLBACK_HOST = '127.0.0.1';
const CHANNEL = 'VCU0000001:1';

function buildFacade(fakeCcu: FakeCcu): Homematic {
  const holder: { central?: CentralUnit } = {};
  const central = new CentralUnit({
    centralName: CENTRAL_NAME,
    host: CALLBACK_HOST,
    interfaces: [Interface.HMIP_RF],
    credentials: { username: USERNAME, password: PASSWORD },
    callback: { host: CALLBACK_HOST, port: 0 },
    storageBackend: new InMemoryStorageBackend(),
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

describe('central links (fake CCU)', () => {
  let fakeCcu: FakeCcu;
  let hm: Homematic;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({ username: USERNAME, password: PASSWORD });
    fakeCcu.addDirectLink({
      sender: CHANNEL,
      receiver: 'OEQ0000001:1',
      name: 'Stairs light',
    });
    await fakeCcu.start();
    hm = buildFacade(fakeCcu);
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
    await fakeCcu.stop();
  });

  it('reads direct links and reports no central link until one is created', async () => {
    const before = await hm.getChannelLinkState(CHANNEL);
    expect(before.central).toBe(false);
    expect(before.links).toEqual([
      { sender: CHANNEL, receiver: 'OEQ0000001:1', name: 'Stairs light' },
    ]);
  });

  it('creates a central link once, then removes it', async () => {
    await hm.createCentralLink(CHANNEL);
    expect(await hm.getChannelLinkState(CHANNEL)).toMatchObject({ central: true });
    expect(fakeCcu.reportValueUsageCalls()).toEqual([
      { address: CHANNEL, valueId: 'PRESS_SHORT', refCounter: 1 },
    ]);

    await hm.createCentralLink(CHANNEL);
    expect(fakeCcu.reportValueUsageCalls()).toHaveLength(1);

    await hm.removeCentralLink(CHANNEL);
    expect(fakeCcu.reportValueUsageCalls()).toEqual([
      { address: CHANNEL, valueId: 'PRESS_SHORT', refCounter: 1 },
      { address: CHANNEL, valueId: 'PRESS_SHORT', refCounter: 0 },
    ]);
    expect((await hm.getChannelLinkState(CHANNEL)).central).toBe(false);

    await hm.removeCentralLink(CHANNEL);
    expect(fakeCcu.reportValueUsageCalls()).toHaveLength(2);
  });

  it('surfaces a typed error when the interface refuses reportValueUsage', async () => {
    fakeCcu.setReportValueUsageFault('reportValueUsage refused');
    await expect(hm.createCentralLink(CHANNEL)).rejects.toBeInstanceOf(ClientError);
    expect((await hm.getChannelLinkState(CHANNEL)).central).toBe(false);
  });

  it('rejects an unknown channel before hitting the wire', async () => {
    await expect(hm.createCentralLink('NOPE:1')).rejects.toBeInstanceOf(ValidationError);
    expect(fakeCcu.reportValueUsageCalls()).toEqual([]);
  });

  it('exposes CCU channel names and a null name where the CCU has none', () => {
    const device = hm.devices()[0]!;
    expect(device.name).toBe('Window Contact');
    const sensor = device.channels.find((channel) => channel.address === CHANNEL)!;
    expect(sensor.name).toBe('Window Contact Sensor');
    const maintenance = device.channels.find((channel) => channel.address === 'VCU0000001:0')!;
    expect(maintenance.name).toBeNull();
  });
});

describe('channel names when Device.listAllDetail fails', () => {
  let fakeCcu: FakeCcu;
  let hm: Homematic;

  beforeEach(async () => {
    fakeCcu = new FakeCcu({
      username: USERNAME,
      password: PASSWORD,
      failDeviceDetails: true,
    });
    await fakeCcu.start();
    hm = buildFacade(fakeCcu);
  });

  afterEach(async () => {
    await hm.stop();
    await fakeCcu.stop();
  });

  it('keeps the connection up and exposes null names', async () => {
    await expect(hm.start()).resolves.toBeUndefined();
    const device = hm.devices()[0]!;
    expect(device.address).toBe('VCU0000001');
    expect(device.name).toBeNull();
    expect(device.channels.every((channel) => channel.name === null)).toBe(true);
    // Seeded VALUES are readable: the connection is up, only the name read failed.
    expect(typeof hm.getValue({ device: 'VCU0000001', channel: 1, parameter: 'STATE' })).toBe(
      'boolean',
    );
  });
});
