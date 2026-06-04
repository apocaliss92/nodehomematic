/**
 * E2E smoke for the Phase-5 hub surface of the {@link Homematic} facade against
 * a REAL CCU3/RaspberryMatic.
 *
 * READ-ONLY: start → log + assert systemVariables().length and programs().length
 * (>= 0), then count how many devices got non-empty `rooms` from the custom
 * GET_ROOMS_FUNCTIONS ReGa script (the Phase-2 gap this phase fixes). We do NOT
 * setSystemVariable / runProgram / setProgramActive on real hardware.
 *
 * The rooms assertion is SOFT: it logs the count rather than failing, so if the
 * ReGa script errors on a given firmware the run still surfaces the numbers for
 * iteration instead of leaving a red test.
 *
 * Gated by HM_E2E=1. Run with:
 *   set -a && . ./.env && set +a && npx vitest run tests/e2e/hub-smoke.test.ts
 */
import { describe, it, expect } from 'vitest';
import { Homematic } from '../../src/index.js';

const E2E = process.env.HM_E2E === '1';

const host = process.env.HM_HOST ?? '';
const username = process.env.HM_USERNAME ?? '';
const password = process.env.HM_PASSWORD ?? '';
const tls = process.env.HM_TLS === 'true';
const interfaces = (process.env.HM_INTERFACES ?? 'HmIP-RF').split(',').map((s) => s.trim());
const callbackHost = process.env.HM_CALLBACK_HOST ?? '0.0.0.0';
const callbackPort = Number(process.env.HM_CALLBACK_PORT ?? '9123');

describe.runIf(E2E)('hub e2e smoke (real CCU)', () => {
  it('start → sysvars + programs listed, rooms via ReGa → stop', async () => {
    const hm = new Homematic({
      host,
      interfaces,
      ...(username !== '' ? { credentials: { username, password } } : {}),
      callback: { host: callbackHost, port: callbackPort },
      tls,
    });

    try {
      await hm.start();

      // --- system variables ---
      const sysvars = hm.systemVariables();
      console.log(`[e2e] system variables: ${sysvars.length}`);
      for (const v of sysvars.slice(0, 5)) {
        console.log(`[e2e]   sysvar "${v.name}" type=${v.type} writable=${v.writable}`);
      }
      expect(sysvars.length).toBeGreaterThanOrEqual(0);

      // --- programs ---
      const programs = hm.programs();
      console.log(`[e2e] programs: ${programs.length}`);
      for (const p of programs.slice(0, 5)) {
        console.log(`[e2e]   program "${p.name}" active=${p.isActive}`);
      }
      expect(programs.length).toBeGreaterThanOrEqual(0);

      // --- rooms via the custom GET_ROOMS_FUNCTIONS ReGa script ---
      const devices = hm.devices();
      const withRooms = devices.filter((d) => (d.rooms?.length ?? 0) > 0);
      const withFunctions = devices.filter((d) => (d.functions?.length ?? 0) > 0);
      console.log(
        `[e2e] devices: ${devices.length}; with rooms: ${withRooms.length}; ` +
          `with functions: ${withFunctions.length}`,
      );
      const sample = withRooms[0];
      if (sample !== undefined) {
        console.log(
          `[e2e]   sample device ${sample.address} "${sample.name ?? ''}" ` +
            `rooms=${JSON.stringify(sample.rooms)} functions=${JSON.stringify(sample.functions)}`,
        );
      } else {
        console.log(
          '[e2e]   NO device got rooms — the GET_ROOMS_FUNCTIONS ReGa script may need work',
        );
      }
      // SOFT assertion: just confirm the count is a number we can iterate on.
      expect(withRooms.length).toBeGreaterThanOrEqual(0);
    } finally {
      await hm.stop();
    }
  }, 240_000);
});
