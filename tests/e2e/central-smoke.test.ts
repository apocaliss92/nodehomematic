/**
 * Phase 2 (CentralUnit) E2E smoke against a REAL CCU3/RaspberryMatic.
 *
 * Read-only: start → full HmIP-RF discovery → verify registry/names →
 * brief wait for value events → stop. NO setValue (does not modify the devices).
 *
 * Gated by HM_E2E=1. Run with: npm run test:e2e
 * (full discovery may take tens of seconds on a CCU with many channels).
 */
import { describe, it, expect } from 'vitest';

import { Interface } from '../../src/support/constants.js';
import { CentralUnit } from '../../src/central/central-unit.js';
import { InMemoryStorageBackend } from '../../src/central/store/storage-backend.js';
import type { CentralEvent } from '../../src/central/events.js';

const E2E = process.env.HM_E2E === '1';

const host = process.env.HM_HOST ?? '';
const username = process.env.HM_USERNAME ?? '';
const password = process.env.HM_PASSWORD ?? '';
const tls = process.env.HM_TLS === 'true';
const callbackHost = process.env.HM_CALLBACK_HOST ?? '0.0.0.0';
const callbackPort = Number(process.env.HM_CALLBACK_PORT ?? '9123');

describe.runIf(E2E)('central e2e smoke (real CCU)', () => {
  it('start → discovery → registry/names → events → stop', async () => {
    const valueEvents: CentralEvent[] = [];
    const central = new CentralUnit({
      centralName: 'nodehomematic-e2e',
      host,
      interfaces: [Interface.HMIP_RF],
      credentials: { username, password },
      callback: { host: callbackHost, port: callbackPort },
      storageBackend: new InMemoryStorageBackend(),
      tls,
    });

    central.eventBus.subscribe({
      type: 'valueReceived',
      handler: (e) => {
        valueEvents.push(e);
      },
    });

    let ready = false;
    central.eventBus.subscribe({
      type: 'ready',
      handler: () => {
        ready = true;
      },
    });

    try {
      await central.start();

      const devices = central.devices();
      const named = devices.filter((d) => d.name !== undefined && d.name !== '');
      const withRooms = devices.filter((d) => (d.rooms?.length ?? 0) > 0);
      const totalChannels = devices.reduce((acc, d) => acc + d.channels.length, 0);

      console.log(
        `[e2e] discovery HmIP-RF → ${devices.length} devices, ${totalChannels} channels, ` +
          `${named.length} named, ${withRooms.length} with a room`,
      );
      if (named[0]) {
        console.log(`[e2e] example device: ${named[0].address} "${named[0].name ?? ''}"`);
      }

      expect(ready).toBe(true);
      expect(devices.length).toBeGreaterThan(0);
      // the names come from the JSON-RPC merge (Device.listAllDetail): if >0, the shapes are correct
      expect(named.length).toBeGreaterThan(0);

      // brief window for spontaneous value events
      await new Promise((r) => setTimeout(r, 5_000));
      console.log(`[e2e] valueReceived in 5s: ${valueEvents.length}`);
    } finally {
      await central.stop();
    }
  }, 240_000);
});
