/**
 * Build a {@link Homematic} facade wired to a {@link FakeCcu} on HmIP-RF, with
 * or without WebUI credentials (JSON-RPC).
 */
import type { FakeCcu } from '../fake-ccu/fake-ccu.js';
import { createHomematicForTest } from '../../../src/api/homematic.js';
import type { Homematic } from '../../../src/api/homematic.js';
import { InterfaceClient } from '../../../src/transport/interface-client.js';
import { JsonRpcClient } from '../../../src/transport/jsonrpc/client.js';
import { InMemoryStorageBackend } from '../../../src/central/store/storage-backend.js';
import { CentralUnit } from '../../../src/central/central-unit.js';
import { Interface } from '../../../src/support/constants.js';

export const FAKE_USERNAME = 'Admin';
export const FAKE_PASSWORD = 'secret';
const CENTRAL_NAME = 'TestCCU';
const CALLBACK_HOST = '127.0.0.1';

export function buildFakeFacade(fakeCcu: FakeCcu, withCredentials = true): Homematic {
  const holder: { central?: CentralUnit } = {};
  const central = new CentralUnit({
    centralName: CENTRAL_NAME,
    host: CALLBACK_HOST,
    interfaces: [Interface.HMIP_RF],
    ...(withCredentials
      ? {
          credentials: { username: FAKE_USERNAME, password: FAKE_PASSWORD },
          jsonClient: new JsonRpcClient({ url: fakeCcu.jsonRpcUrl }),
        }
      : {}),
    callback: { host: CALLBACK_HOST, port: 0 },
    storageBackend: new InMemoryStorageBackend(),
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
