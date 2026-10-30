/**
 * CCU-management XML-RPC calls on {@link InterfaceClient}: listBidcosInterfaces,
 * setInstallMode / getInstallModeRemaining and deleteDevice. Faults carry the
 * method name; an answer the CCU did not give is `null`, never 0.
 */
import { describe, it, expect } from 'vitest';
import { InterfaceClient } from '../../../src/transport/interface-client.js';
import type { XmlRpcClientLike } from '../../../src/transport/interface-client.js';
import { Interface } from '../../../src/support/constants.js';
import { CcuManagementError, ClientError } from '../../../src/support/errors.js';
import type { XmlRpcValue } from '../../../src/transport/xmlrpc/types.js';

interface RecordedCall {
  readonly method: string;
  readonly params: readonly XmlRpcValue[];
}

function makeSubject(
  impl: (method: string, params: readonly XmlRpcValue[]) => Promise<XmlRpcValue>,
  iface: Interface = Interface.BIDCOS_RF,
): { subject: InterfaceClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: XmlRpcClientLike = {
    call: (method, params) => {
      calls.push({ method, params });
      return impl(method, params);
    },
  };
  const subject = new InterfaceClient({
    centralName: 'MyCCU',
    interface: iface,
    host: 'ccu.local',
    callbackUrlProvider: () => 'http://callback:9000',
    makeClient: () => client,
    retryOptions: { sleep: () => Promise.resolve(), baseDelayMs: 0, jitter: 0 },
  });
  return { subject, calls };
}

describe('InterfaceClient — CCU management', () => {
  it('listBidcosInterfaces reads CONNECTED / DEFAULT sent as 0/1 integers (OpenCCU)', async () => {
    const { subject } = makeSubject(() =>
      Promise.resolve([
        { ADDRESS: 'KEQ0000001', DUTY_CYCLE: 7, CONNECTED: 1, DEFAULT: 1 },
        { ADDRESS: '3014F711A0000001', DUTY_CYCLE: 31, CONNECTED: 0, DEFAULT: 0 },
        { ADDRESS: 'ODD0000003', CONNECTED: 'yes' },
      ]),
    );
    const gateways = await subject.listBidcosInterfaces();
    expect(gateways.map((g) => [g.connected, g.isDefault])).toEqual([
      [true, true],
      [false, false],
      [null, false],
    ]);
  });

  it('listBidcosInterfaces maps the gateway structs; absent fields are null', async () => {
    const { subject, calls } = makeSubject(() =>
      Promise.resolve([
        {
          ADDRESS: 'KEQ0000001',
          DESCRIPTION: 'CCU3',
          DUTY_CYCLE: 12,
          CONNECTED: true,
          DEFAULT: true,
          FIRMWARE_VERSION: '4.4.18',
          TYPE: 'CCU3',
        },
        { ADDRESS: 'LGW0000002', CONNECTED: false },
      ]),
    );
    const gateways = await subject.listBidcosInterfaces();
    expect(calls[0]?.method).toBe('listBidcosInterfaces');
    expect(gateways).toEqual([
      {
        address: 'KEQ0000001',
        description: 'CCU3',
        dutyCycle: 12,
        connected: true,
        isDefault: true,
        firmware: '4.4.18',
        type: 'CCU3',
      },
      {
        address: 'LGW0000002',
        description: null,
        dutyCycle: null,
        connected: false,
        isDefault: false,
        firmware: null,
        type: null,
      },
    ]);
  });

  it('setInstallMode(on) sends [true, seconds] and an explicit BidCos mode as a third arg', async () => {
    const { subject, calls } = makeSubject(() => Promise.resolve(true));
    await subject.setInstallMode({ on: true, seconds: 90, mode: 2 });
    expect(calls[0]).toEqual({ method: 'setInstallMode', params: [true, 90, 2] });
  });

  it('setInstallMode without a mode sends only [on, seconds]; off sends [false]', async () => {
    const { subject, calls } = makeSubject(() => Promise.resolve(true), Interface.HMIP_RF);
    await subject.setInstallMode({ on: true, seconds: 60 });
    await subject.setInstallMode({ on: false });
    expect(calls.map((c) => c.params)).toEqual([[true, 60], [false]]);
  });

  it('getInstallModeRemaining returns the seconds, and null for a non-integer answer', async () => {
    const ok = makeSubject(() => Promise.resolve(42));
    await expect(ok.subject.getInstallModeRemaining()).resolves.toBe(42);
    const bad = makeSubject(() => Promise.resolve('nope'));
    await expect(bad.subject.getInstallModeRemaining()).resolves.toBeNull();
  });

  it('deleteDevice sends [address, flags]', async () => {
    const { subject, calls } = makeSubject(() => Promise.resolve(null));
    await subject.deleteDevice('NEQ123', 3);
    expect(calls[0]).toEqual({ method: 'deleteDevice', params: ['NEQ123', 3] });
  });

  it('a fault is rethrown as CcuManagementError naming the method and keeping the CCU text', async () => {
    const { subject } = makeSubject(() =>
      Promise.reject(new ClientError('XML-RPC fault -1: Device is busy')),
    );
    const failure = await subject.deleteDevice('NEQ123', 0).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CcuManagementError);
    if (failure instanceof CcuManagementError) {
      expect(failure.method).toBe('deleteDevice');
      expect(failure.message).toContain('deleteDevice');
      expect(failure.message).toContain('-1');
      expect(failure.message).toContain('Device is busy');
    }
  });
});
