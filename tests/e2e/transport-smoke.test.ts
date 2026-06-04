/**
 * E2E smoke test del layer transport contro una CCU3/RaspberryMatic REALE.
 *
 * Read-only: login JSON-RPC, listDevices XML-RPC, init callback + breve attesa
 * eventi + deinit. NON esegue setValue/putParamset (non modifica i dispositivi).
 *
 * Gated da HM_E2E=1. Eseguire con le variabili del .env nell'ambiente, es.:
 *   set -a; source .env; set +a; npx vitest run tests/e2e/transport-smoke.test.ts
 */
import { describe, it, expect } from 'vitest';

import { Interface } from '../../src/support/constants.js';
import { JsonRpcClient } from '../../src/transport/jsonrpc/client.js';
import { SessionManager } from '../../src/transport/jsonrpc/session.js';
import { JsonRpcMethod } from '../../src/transport/jsonrpc/methods.js';
import { InterfaceClient } from '../../src/transport/interface-client.js';
import {
  CallbackServer,
  type RawCallbackEvent,
} from '../../src/transport/callback-server/server.js';

const E2E = process.env.HM_E2E === '1';

const host = process.env.HM_HOST ?? '';
const username = process.env.HM_USERNAME ?? '';
const password = process.env.HM_PASSWORD ?? '';
const tls = process.env.HM_TLS === 'true';
const interfaces = (process.env.HM_INTERFACES ?? 'HmIP-RF').split(',').map((s) => s.trim());
const callbackHost = process.env.HM_CALLBACK_HOST ?? '0.0.0.0';
const callbackPort = Number(process.env.HM_CALLBACK_PORT ?? '9123');

const scheme = tls ? 'https' : 'http';

function pickInterface(): Interface {
  if (interfaces.includes('HmIP-RF')) return Interface.HMIP_RF;
  if (interfaces.includes('BidCos-RF')) return Interface.BIDCOS_RF;
  return Interface.HMIP_RF;
}

const xmlRpcPort: Record<string, number> = {
  [Interface.HMIP_RF]: 2010,
  [Interface.BIDCOS_RF]: 2001,
};

describe.runIf(E2E)('transport e2e smoke (CCU reale)', () => {
  it('JSON-RPC: login + Device.listAllDetail', async () => {
    const client = new JsonRpcClient({
      url: `${scheme}://${host}`,
      tls: { rejectUnauthorized: false },
    });
    const session = new SessionManager({ client, username, password });
    const sessionId = await session.login();
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    const detail = await client.post(JsonRpcMethod.DEVICE_LIST_ALL_DETAIL, {}, { sessionId });
    expect(Array.isArray(detail)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[e2e] Device.listAllDetail → ${(detail as unknown[]).length} dispositivi`);

    await session.logout();
    await client.close();
  }, 30_000);

  it('XML-RPC: listDevices sull’interfaccia selezionata', async () => {
    const iface = pickInterface();
    const port = xmlRpcPort[iface] ?? 2010;
    const client = new InterfaceClient({
      centralName: 'nodehomematic-e2e',
      interface: iface,
      host,
      port,
      tls,
      callbackUrlProvider: () => `http://${callbackHost}:${String(callbackPort)}`,
    });
    const devices = await client.listDevices();
    expect(Array.isArray(devices)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[e2e] ${iface} listDevices → ${devices.length} entry (device+canali)`);
    expect(devices.length).toBeGreaterThan(0);
  }, 30_000);

  it('Callback: init → attesa eventi (≤8s) → deinit', async () => {
    const iface = pickInterface();
    const port = xmlRpcPort[iface] ?? 2010;
    const received: RawCallbackEvent[] = [];
    const server = new CallbackServer({
      host: '0.0.0.0',
      port: callbackPort,
      onEvent: (e) => received.push(e),
    });
    await server.start();

    const client = new InterfaceClient({
      centralName: 'nodehomematic-e2e',
      interface: iface,
      host,
      port,
      tls,
      callbackUrlProvider: () => `http://${callbackHost}:${String(server.port)}`,
    });

    try {
      await client.initProxy();
      // breve finestra per ricevere eventuali push spontanei (newDevices/event/pong)
      await new Promise((r) => setTimeout(r, 8_000));
      // eslint-disable-next-line no-console
      console.log(
        `[e2e] callback ricevuti in 8s: ${received.length}` +
          (received.length
            ? ` (tipi: ${[...new Set(received.map((e) => e.type))].join(',')})`
            : ''),
      );
    } finally {
      await client.deinitProxy().catch(() => undefined);
      await server.stop();
    }
    // non asseriamo received>0 (dipende da attività dei device); l'init/deinit senza throw è il segnale chiave
    expect(true).toBe(true);
  }, 30_000);
});
