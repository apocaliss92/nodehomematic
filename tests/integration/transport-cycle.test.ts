/**
 * End-to-end transport cycle against an in-process fake CCU — NO hardware and
 * NO mocks of our own modules. Wires the REAL {@link FakeCcu},
 * {@link CallbackServer}, {@link InterfaceClient}, {@link JsonRpcClient} and
 * {@link SessionManager} together and exercises:
 *   init → listDevices → CCU-pushed event → setValue → deinit, plus a JSON-RPC
 *   login + listAllDetail round-trip (and a wrong-password auth failure).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { CallbackServer } from '../../src/transport/callback-server/server.js';
import type { RawCallbackEvent } from '../../src/transport/callback-server/events.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { SessionManager } from '../../src/transport/jsonrpc/session.js';
import { JsonRpcMethod } from '../../src/transport/jsonrpc/methods.js';
import { AuthFailureError } from '../../src/support/errors.js';
import { Interface } from '../../src/support/constants.js';
import { ClientState } from '../../src/transport/resilience/state-machine.js';

const USERNAME = 'Admin';
const PASSWORD = 'secret';

/** Poll a predicate until it is true or the timeout elapses (no fixed sleeps). */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('transport cycle (fake CCU, real transport modules)', () => {
  let fakeCcu: FakeCcu;
  let callbackServer: CallbackServer;
  let events: RawCallbackEvent[];

  beforeEach(async () => {
    fakeCcu = new FakeCcu({ username: USERNAME, password: PASSWORD });
    await fakeCcu.start();

    events = [];
    callbackServer = new CallbackServer({
      host: '127.0.0.1',
      port: 0,
      onEvent: (event): void => {
        events.push(event);
      },
    });
    await callbackServer.start();
  });

  afterEach(async () => {
    await callbackServer.stop();
    await fakeCcu.stop();
  });

  function makeInterfaceClient(): InterfaceClient {
    return new InterfaceClient({
      centralName: 'TestCCU',
      interface: Interface.HMIP_RF,
      host: '127.0.0.1',
      port: fakeCcu.port,
      callbackUrlProvider: () => `http://127.0.0.1:${callbackServer.port}`,
    });
  }

  it('runs the full init/event/setValue/deinit XML-RPC cycle', async () => {
    const client = makeInterfaceClient();

    // 1. init → CCU records the callback URL + interfaceId; state CONNECTED.
    await client.initProxy();
    expect(client.state).toBe(ClientState.CONNECTED);
    expect(fakeCcu.lastRegistration).toEqual({
      callbackUrl: `http://127.0.0.1:${callbackServer.port}`,
      interfaceId: 'TestCCU-HmIP-RF',
    });

    // 2. listDevices returns the canned descriptions.
    const devices = await client.listDevices();
    expect(devices.map((d) => d.ADDRESS)).toEqual(['VCU0000001', 'VCU0000001:1']);

    // 3. CCU pushes an event; the CallbackServer normalizes it.
    await fakeCcu.emitEvent('VCU0000001:1', 'STATE', true);
    await waitFor(() => events.length > 0);
    expect(events[0]).toEqual({
      type: 'event',
      interfaceId: 'TestCCU-HmIP-RF',
      channelAddress: 'VCU0000001:1',
      parameter: 'STATE',
      value: true,
    });

    // 4. setValue reaches the CCU and is stored (verified via getValue).
    await client.setValue('VCU0000001:1', 'STATE', false);
    expect(fakeCcu.storedValue('VCU0000001:1', 'STATE')).toBe(false);
    const readBack = await client.getValue('VCU0000001:1', 'STATE');
    expect(readBack).toBe(false);

    // 5. deinit → single-arg init records de-registration; state DISCONNECTED.
    await client.deinitProxy();
    expect(fakeCcu.lastDeregistration).toBe(`http://127.0.0.1:${callbackServer.port}`);
    expect(fakeCcu.lastRegistration).toBeUndefined();
    expect(client.state).toBe(ClientState.DISCONNECTED);
  });

  it('performs a JSON-RPC login + listAllDetail round-trip', async () => {
    const jsonClient = new JsonRpcClient({ url: fakeCcu.jsonRpcUrl });
    const session = new SessionManager({
      client: jsonClient,
      username: USERNAME,
      password: PASSWORD,
    });

    const sessionId = await session.login();
    expect(sessionId).toBe('SESSIONID123');
    expect(session.sessionId).toBe('SESSIONID123');

    const detail = await jsonClient.post(JsonRpcMethod.DEVICE_LIST_ALL_DETAIL, {}, { sessionId });
    expect(detail).toEqual([
      { id: '4711', address: 'VCU0000001', name: 'Window Contact', type: 'HmIP-SWDO' },
    ]);

    await jsonClient.close();
  });

  it('rejects a wrong JSON-RPC password with AuthFailureError', async () => {
    const jsonClient = new JsonRpcClient({ url: fakeCcu.jsonRpcUrl });
    const session = new SessionManager({
      client: jsonClient,
      username: USERNAME,
      password: 'wrong-password',
    });

    await expect(session.login()).rejects.toBeInstanceOf(AuthFailureError);

    await jsonClient.close();
  });
});
