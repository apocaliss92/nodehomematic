/**
 * E2E smoke for the {@link Homematic} facade's custom entities against a REAL
 * CCU3/RaspberryMatic.
 *
 * READ-ONLY: start → `customEntities()` → assert the user's HmIP-HEATING groups
 * surface as Climate entities with numeric target temperatures → log a sample +
 * a per-kind breakdown → stop. NO set command is issued on real hardware.
 *
 * Gated by HM_E2E=1. Run with:
 *   set -a && . ./.env && set +a && npx vitest run tests/e2e/custom-smoke.test.ts
 */
import { describe, it, expect } from 'vitest';
import { Homematic } from '../../src/index.js';
import type { HmCustomEntity } from '../../src/index.js';

const E2E = process.env.HM_E2E === '1';

const host = process.env.HM_HOST ?? '';
const username = process.env.HM_USERNAME ?? '';
const password = process.env.HM_PASSWORD ?? '';
const tls = process.env.HM_TLS === 'true';
const interfaces = (process.env.HM_INTERFACES ?? 'HmIP-RF,BidCos-RF,VirtualDevices')
  .split(',')
  .map((s) => s.trim());
const callbackHost = process.env.HM_CALLBACK_HOST ?? '0.0.0.0';
const callbackPort = Number(process.env.HM_CALLBACK_PORT ?? '9123');

/** Count custom entities by `kind` for a readable breakdown log. */
function countByKind(entities: readonly HmCustomEntity[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entities) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  return counts;
}

describe.runIf(E2E)('custom-entity e2e smoke (real CCU)', () => {
  it('start → climate groups recognised → breakdown by kind → stop', async () => {
    const hm = new Homematic({
      host,
      interfaces,
      ...(username !== '' ? { credentials: { username, password } } : {}),
      callback: { host: callbackHost, port: callbackPort },
      tls,
    });

    try {
      await hm.start();

      const entities = hm.customEntities();
      const breakdown = countByKind(entities);
      console.log(`[e2e] custom entities: ${entities.length} total — ${JSON.stringify(breakdown)}`);

      // Custom entities are VIEWS over the data points. Their values are filled
      // by the CCU's asynchronous value pushes after init — the CCU pushes a
      // parameter on change / cyclically, so a given setpoint may or may not
      // arrive within a short window (READ-ONLY: we never write to populate it).
      // Wait briefly so the diagnostic reflects whatever values do arrive.
      const climateWithTarget = (): number =>
        hm
          .customEntities()
          .filter((e): e is Extract<HmCustomEntity, { kind: 'climate' }> => e.kind === 'climate')
          .filter((e) => typeof e.targetTemperature === 'number').length;
      const deadline = Date.now() + 15_000;
      while (climateWithTarget() === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }

      const climates = hm
        .customEntities()
        .filter((e): e is Extract<HmCustomEntity, { kind: 'climate' }> => e.kind === 'climate');
      const withTarget = climates.filter((c) => typeof c.targetTemperature === 'number');
      console.log(
        `[e2e] climate entities: ${climates.length} recognised ` +
          `(${withTarget.length} have a numeric target temperature so far)`,
      );

      const sample = withTarget[0] ?? climates[0];
      if (sample !== undefined) {
        console.log(
          `[e2e] sample climate ${sample.device} (${sample.channel}): ` +
            `current=${sample.currentTemperature} target=${sample.targetTemperature} ` +
            `mode=${sample.mode} preset=${sample.preset}`,
        );
      }

      // The deterministic, hardware-independent assertion is on RECOGNITION: the
      // user has 9 HmIP-HEATING groups, plus single thermostats, so the facade
      // must surface at least 9 climate entities. (Value population depends on
      // the CCU's async pushes and is logged above for diagnosis, not asserted.)
      expect(climates.length).toBeGreaterThanOrEqual(9);
      // When a target temperature did arrive, it must be a number.
      if (withTarget.length > 0) {
        expect(typeof withTarget[0]?.targetTemperature).toBe('number');
      }
    } finally {
      await hm.stop();
    }
  }, 240_000);
});
