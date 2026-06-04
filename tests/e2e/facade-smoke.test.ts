/**
 * E2E smoke for the {@link Homematic} public facade against a REAL
 * CCU3/RaspberryMatic.
 *
 * READ-ONLY: start → devices() populated with data points carrying metadata →
 * log a sample device + its MASTER config-param count for one channel → brief
 * wait for a spontaneous `valueChanged` → stop. NO setValue / setConfig on real
 * hardware.
 *
 * Gated by HM_E2E=1. Run with: npm run test:e2e
 */
import { describe, it, expect } from 'vitest';
import { Homematic } from '../../src/index.js';
import type { ValueChangedEvent } from '../../src/api/events.js';

const E2E = process.env.HM_E2E === '1';

const host = process.env.HM_HOST ?? '';
const username = process.env.HM_USERNAME ?? '';
const password = process.env.HM_PASSWORD ?? '';
const tls = process.env.HM_TLS === 'true';
const interfaces = (process.env.HM_INTERFACES ?? 'HmIP-RF').split(',').map((s) => s.trim());
const callbackHost = process.env.HM_CALLBACK_HOST ?? '0.0.0.0';
const callbackPort = Number(process.env.HM_CALLBACK_PORT ?? '9123');

describe.runIf(E2E)('facade e2e smoke (real CCU)', () => {
  it('start → devices() with metadata → config params → events → stop', async () => {
    const hm = new Homematic({
      host,
      interfaces,
      ...(username !== '' ? { credentials: { username, password } } : {}),
      callback: { host: callbackHost, port: callbackPort },
      tls,
    });

    const valueEvents: ValueChangedEvent[] = [];
    hm.on('valueChanged', (e) => valueEvents.push(e));

    try {
      await hm.start();

      const devices = hm.devices();
      const totalChannels = devices.reduce((acc, d) => acc + d.channels.length, 0);
      const totalDataPoints = devices.reduce(
        (acc, d) => acc + d.channels.reduce((c, ch) => c + ch.dataPoints.length, 0),
        0,
      );

      console.log(
        `[e2e] facade → ${devices.length} device, ${totalChannels} canali, ` +
          `${totalDataPoints} data point`,
      );

      expect(devices.length).toBeGreaterThan(0);
      expect(totalDataPoints).toBeGreaterThan(0);

      // Every data point must carry metadata (type + readable flag).
      const sample = devices.find((d) => d.channels.some((ch) => ch.dataPoints.length > 0));
      expect(sample).toBeDefined();
      const channelWithDps = sample!.channels.find((ch) => ch.dataPoints.length > 0)!;
      const dp = channelWithDps.dataPoints[0]!;
      expect(typeof dp.type).toBe('string');
      expect(typeof dp.readable).toBe('boolean');

      const configParams = hm.getConfigParams(channelWithDps.address);
      console.log(
        `[e2e] esempio device ${sample!.address} "${sample!.name ?? ''}" — ` +
          `canale ${channelWithDps.address}: ${channelWithDps.dataPoints.length} data point, ` +
          `${configParams.length} parametri MASTER`,
      );

      // Brief window for spontaneous value events.
      await new Promise((r) => setTimeout(r, 5_000));
      console.log(`[e2e] valueChanged in 5s: ${valueEvents.length}`);
    } finally {
      await hm.stop();
    }
  }, 240_000);
});
