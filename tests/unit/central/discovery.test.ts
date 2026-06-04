import { describe, it, expect, beforeEach } from 'vitest';
import {
  discoverInterface,
  mergeDetails,
  warmStart,
  type DetailsJsonRpcClient,
  type DiscoverySource,
} from '../../../src/central/discovery.js';
import {
  DeviceDescriptionCache,
  ParamsetDescriptionCache,
} from '../../../src/central/store/description-cache.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { Operations, ParameterType, ParamsetKey } from '../../../src/support/constants.js';
import type { DeviceDescription, ParameterData } from '../../../src/transport/xmlrpc/types.js';

const INTERFACE_ID = 'test-HmIP-RF';

const DEVICE: DeviceDescription = {
  ADDRESS: 'VCU0000001',
  TYPE: 'HmIP-SWDO',
  PARAMSETS: ['MASTER'],
  CHILDREN: ['VCU0000001:0', 'VCU0000001:1'],
};

const CHANNEL_0: DeviceDescription = {
  ADDRESS: 'VCU0000001:0',
  TYPE: 'MAINTENANCE',
  PARENT: 'VCU0000001',
  PARAMSETS: ['MASTER'],
};

const CHANNEL_1: DeviceDescription = {
  ADDRESS: 'VCU0000001:1',
  TYPE: 'SHUTTER_CONTACT',
  PARENT: 'VCU0000001',
  PARAMSETS: ['VALUES', 'MASTER', 'LINK'],
  DIRECTION: 1,
};

const VALUES_PARAMSET: Record<string, ParameterData> = {
  STATE: {
    TYPE: 'BOOL',
    OPERATIONS: Operations.READ | Operations.WRITE | Operations.EVENT,
    FLAGS: 1,
  },
  LEVEL: {
    TYPE: 'FLOAT',
    OPERATIONS: Operations.READ | Operations.EVENT,
    FLAGS: 1,
    MIN: 0,
    MAX: 1,
  },
};

const MASTER_PARAMSET: Record<string, ParameterData> = {
  CYCLIC_INFO_MSG: { TYPE: 'BOOL', OPERATIONS: Operations.READ | Operations.WRITE, FLAGS: 1 },
};

/** Fake DiscoverySource recording every call and returning canned data. */
class FakeSource implements DiscoverySource {
  public readonly interfaceId = INTERFACE_ID;
  public listDevicesCalls = 0;
  public readonly paramsetCalls: Array<{ channelAddress: string; paramsetKey: string }> = [];

  public constructor(private readonly entries: DeviceDescription[]) {}

  public async listDevices(): Promise<DeviceDescription[]> {
    this.listDevicesCalls += 1;
    return this.entries;
  }

  public async getParamsetDescription(
    channelAddress: string,
    paramsetKey: string,
  ): Promise<Record<string, ParameterData>> {
    this.paramsetCalls.push({ channelAddress, paramsetKey });
    if (paramsetKey === ParamsetKey.VALUES) return { ...VALUES_PARAMSET };
    if (paramsetKey === ParamsetKey.MASTER) return { ...MASTER_PARAMSET };
    return {};
  }
}

function makeCaches(): {
  deviceCache: DeviceDescriptionCache;
  paramsetCache: ParamsetDescriptionCache;
} {
  const backend = new InMemoryStorageBackend();
  return {
    deviceCache: new DeviceDescriptionCache(backend, 'devices'),
    paramsetCache: new ParamsetDescriptionCache(backend, 'paramsets'),
  };
}

describe('central/discovery discoverInterface', () => {
  let source: FakeSource;
  let deviceCache: DeviceDescriptionCache;
  let paramsetCache: ParamsetDescriptionCache;

  beforeEach(() => {
    source = new FakeSource([DEVICE, CHANNEL_0, CHANNEL_1]);
    ({ deviceCache, paramsetCache } = makeCaches());
  });

  it('fetches only VALUES and MASTER paramsets, never LINK', async () => {
    await discoverInterface({ source, deviceCache, paramsetCache });

    const keys = source.paramsetCalls.map((c) => c.paramsetKey);
    expect(keys).toContain(ParamsetKey.VALUES);
    expect(keys).toContain(ParamsetKey.MASTER);
    expect(keys).not.toContain(ParamsetKey.LINK);
    // CHANNEL_1 has VALUES+MASTER+LINK (fetch 2), CHANNEL_0 has MASTER (fetch 1).
    expect(source.paramsetCalls).toHaveLength(3);
    expect(source.paramsetCalls).toContainEqual({
      channelAddress: 'VCU0000001:1',
      paramsetKey: ParamsetKey.VALUES,
    });
  });

  it('builds a DeviceNode with channels and decoded parameter specs', async () => {
    const nodes = await discoverInterface({ source, deviceCache, paramsetCache });

    expect(nodes).toHaveLength(1);
    const device = nodes[0];
    expect(device.address).toBe('VCU0000001');
    expect(device.type).toBe('HmIP-SWDO');
    expect(device.interfaceId).toBe(INTERFACE_ID);
    expect(device.channels.map((c) => c.address)).toEqual(['VCU0000001:0', 'VCU0000001:1']);

    const ch1 = device.channels.find((c) => c.address === 'VCU0000001:1');
    expect(ch1).toBeDefined();
    expect(ch1?.index).toBe(1);
    expect(ch1?.type).toBe('SHUTTER_CONTACT');
    expect(ch1?.direction).toBe(1);

    const state = ch1?.parameters.get('STATE');
    expect(state?.VALUES?.type).toBe(ParameterType.BOOL);
    expect(state?.VALUES?.readable).toBe(true);
    expect(state?.VALUES?.writable).toBe(true);
    expect(state?.VALUES?.hasEvents).toBe(true);

    const level = ch1?.parameters.get('LEVEL');
    expect(level?.VALUES?.type).toBe(ParameterType.FLOAT);
    expect(level?.VALUES?.readable).toBe(true);
    expect(level?.VALUES?.writable).toBe(false);
    expect(level?.VALUES?.hasEvents).toBe(true);

    // MASTER paramset for the channel was merged alongside VALUES.
    const cyclic = ch1?.parameters.get('CYCLIC_INFO_MSG');
    expect(cyclic?.MASTER?.type).toBe(ParameterType.BOOL);
    expect(cyclic?.MASTER?.writable).toBe(true);
  });

  it('populates both caches', async () => {
    await discoverInterface({ source, deviceCache, paramsetCache });

    expect(deviceCache.get(INTERFACE_ID, 'VCU0000001')?.TYPE).toBe('HmIP-SWDO');
    expect(deviceCache.get(INTERFACE_ID, 'VCU0000001:1')?.TYPE).toBe('SHUTTER_CONTACT');
    expect(
      paramsetCache.getParamset(INTERFACE_ID, 'VCU0000001:1', ParamsetKey.VALUES),
    ).toBeDefined();
    expect(
      paramsetCache.getParamset(INTERFACE_ID, 'VCU0000001:1', ParamsetKey.MASTER),
    ).toBeDefined();
    expect(
      paramsetCache.getParamset(INTERFACE_ID, 'VCU0000001:1', ParamsetKey.LINK),
    ).toBeUndefined();
  });

  it('tolerates a channel with missing/empty PARAMSETS', async () => {
    const bareChannel: DeviceDescription = {
      ADDRESS: 'VCU0000001:2',
      TYPE: 'X',
      PARENT: 'VCU0000001',
    };
    const src = new FakeSource([{ ...DEVICE, CHILDREN: ['VCU0000001:2'] }, bareChannel]);
    const nodes = await discoverInterface({ source: src, deviceCache, paramsetCache });
    expect(src.paramsetCalls).toHaveLength(0);
    expect(nodes[0].channels[0].parameters.size).toBe(0);
  });

  it('merges name/rooms/functions from details when provided', async () => {
    const nodes = await discoverInterface({
      source,
      deviceCache,
      paramsetCache,
      details: {
        nameByAddress: new Map([['VCU0000001', 'Front Door']]),
        roomsByAddress: new Map([['VCU0000001', ['Hallway']]]),
        functionsByAddress: new Map([['VCU0000001', ['Security']]]),
      },
    });

    expect(nodes[0].name).toBe('Front Door');
    expect(nodes[0].rooms).toEqual(['Hallway']);
    expect(nodes[0].functions).toEqual(['Security']);
  });

  it('resolves rooms onto a DeviceNode via mergeDetails channelId join', async () => {
    // DEVICE address is VCU0000001 with channel VCU0000001:1. Build details from
    // real CCU shapes where Room.channelIds references the channel numeric id.
    const client: DetailsJsonRpcClient = {
      async post(method: string): Promise<unknown> {
        if (method === 'Device.listAllDetail') {
          return [
            {
              address: 'VCU0000001',
              name: 'Front Door',
              channels: [{ id: '10', address: 'VCU0000001:1', name: 'Contact' }],
            },
          ];
        }
        if (method === 'Room.getAll') return [{ id: '1', name: 'Kitchen', channelIds: ['10'] }];
        if (method === 'Subsection.getAll')
          return [{ id: '2', name: 'Security', channelIds: ['10'] }];
        return null;
      },
    };
    const details = await mergeDetails(client);

    const nodes = await discoverInterface({ source, deviceCache, paramsetCache, details });
    expect(nodes[0].name).toBe('Front Door');
    expect(nodes[0].rooms).toContain('Kitchen');
    expect(nodes[0].functions).toContain('Security');
  });
});

describe('central/discovery mergeDetails', () => {
  it('parses listAllDetail + rooms + subsections via channelId→address join', async () => {
    // REAL CCU shapes: Device.listAllDetail channels carry numeric `id` AND
    // `address`; Room/Subsection `channelIds` reference those numeric ids.
    const responses: Record<string, unknown> = {
      'Device.listAllDetail': [
        {
          id: '100',
          address: 'ABC',
          name: 'Front Door',
          interface: INTERFACE_ID,
          type: 'HmIP-SWDO',
          channels: [{ id: '10', address: 'ABC:1', name: 'Contact', index: 1 }],
        },
      ],
      'Room.getAll': [{ id: '1', name: 'Kitchen', description: '', channelIds: ['10'] }],
      'Subsection.getAll': [{ id: '2', name: 'Security', description: '', channelIds: ['10'] }],
    };
    const client: DetailsJsonRpcClient = {
      async post(method: string): Promise<unknown> {
        return responses[method] ?? null;
      },
    };

    const details = await mergeDetails(client);
    // Names still work (no regression): device + channel addresses → names.
    expect(details.nameByAddress.get('ABC')).toBe('Front Door');
    expect(details.nameByAddress.get('ABC:1')).toBe('Contact');

    // Rooms resolve to BOTH the channel address and the derived device address.
    expect(details.roomsByAddress.get('ABC:1')).toContain('Kitchen');
    expect(details.roomsByAddress.get('ABC')).toContain('Kitchen');

    // Subsections → functions, same join.
    expect(details.functionsByAddress.get('ABC:1')).toContain('Security');
    expect(details.functionsByAddress.get('ABC')).toContain('Security');
  });

  it('unions multiple channels rooms onto the device address, deduped', async () => {
    const responses: Record<string, unknown> = {
      'Device.listAllDetail': [
        {
          address: 'DEV',
          name: 'Multi',
          channels: [
            { id: '20', address: 'DEV:1', name: 'C1' },
            { id: '21', address: 'DEV:2', name: 'C2' },
          ],
        },
      ],
      'Room.getAll': [
        { id: '1', name: 'Kitchen', channelIds: ['20'] },
        { id: '2', name: 'Living', channelIds: ['21'] },
        { id: '3', name: 'Kitchen', channelIds: ['21'] }, // duplicate name on a 2nd channel
      ],
    };
    const client: DetailsJsonRpcClient = {
      async post(method: string): Promise<unknown> {
        return responses[method] ?? null;
      },
    };

    const details = await mergeDetails(client);
    const devRooms = details.roomsByAddress.get('DEV') ?? [];
    expect([...devRooms].sort()).toEqual(['Kitchen', 'Living']);
    expect(details.roomsByAddress.get('DEV:1')).toEqual(['Kitchen']);
    expect([...(details.roomsByAddress.get('DEV:2') ?? [])].sort()).toEqual(['Kitchen', 'Living']);
  });

  it('skips a room whose channelId is unknown without throwing or bogus entries', async () => {
    const responses: Record<string, unknown> = {
      'Device.listAllDetail': [
        { address: 'ABC', name: 'Front Door', channels: [{ id: '10', address: 'ABC:1' }] },
      ],
      'Room.getAll': [{ id: '1', name: 'Ghost', channelIds: ['9999'] }],
    };
    const client: DetailsJsonRpcClient = {
      async post(method: string): Promise<unknown> {
        return responses[method] ?? null;
      },
    };

    const details = await mergeDetails(client);
    expect(details.roomsByAddress.size).toBe(0);
    expect(details.roomsByAddress.get('ABC')).toBeUndefined();
  });

  it('does not throw when a field is missing in an entry', async () => {
    const client: DetailsJsonRpcClient = {
      async post(method: string): Promise<unknown> {
        if (method === 'Device.listAllDetail') {
          return [{ address: 'VCU0000001' }, { name: 'orphan, no address' }, 'not-an-object'];
        }
        if (method === 'Room.getAll') return [{ channelIds: ['x'] }, { name: 'NoMembers' }];
        return null;
      },
    };

    const details = await mergeDetails(client, 'session-123');
    expect(details.nameByAddress.size).toBe(0);
    expect(details.roomsByAddress.size).toBe(0);
    expect(details.functionsByAddress.size).toBe(0);
  });

  it('returns empty maps when a call throws', async () => {
    const client: DetailsJsonRpcClient = {
      async post(): Promise<unknown> {
        throw new Error('network down');
      },
    };
    const details = await mergeDetails(client);
    expect(details.nameByAddress.size).toBe(0);
    expect(details.roomsByAddress.size).toBe(0);
    expect(details.functionsByAddress.size).toBe(0);
  });
});

describe('central/discovery warmStart', () => {
  it('rebuilds the same graph from caches without calling the source', async () => {
    const source = new FakeSource([DEVICE, CHANNEL_0, CHANNEL_1]);
    const { deviceCache, paramsetCache } = makeCaches();

    const discovered = await discoverInterface({ source, deviceCache, paramsetCache });

    // Reset the spy counters; warmStart must not touch the source.
    source.listDevicesCalls = 0;
    source.paramsetCalls.length = 0;

    const warmed = warmStart({ interfaceId: INTERFACE_ID, deviceCache, paramsetCache });

    expect(source.listDevicesCalls).toBe(0);
    expect(source.paramsetCalls).toHaveLength(0);
    expect(JSON.stringify(serialize(warmed))).toBe(JSON.stringify(serialize(discovered)));
  });
});

/** Make a graph comparable by JSON, flattening the parameter Maps. */
function serialize(nodes: ReturnType<typeof warmStart>): unknown {
  return nodes.map((d) => ({
    address: d.address,
    type: d.type,
    channels: d.channels.map((c) => ({
      address: c.address,
      index: c.index,
      type: c.type,
      parameters: [...c.parameters.entries()],
    })),
  }));
}
