/**
 * {@link DeviceProfileRegistry} — maps a device TYPE to the custom-entity
 * configuration(s) it should produce. Matching is data-driven: the model name
 * is normalised (lowercased, `hb-`→`hm-`), then matched EXACTLY first and by
 * PREFIX second. A single model may aggregate multiple configs (e.g. lock plus
 * button-lock), and results are collected across all matching registrations.
 */

import type { CustomEntity, CustomEntityInit } from './base.js';
import type { DeviceProfile } from './profile.js';

/** Constructor type for the custom-entity base class. */
export type CustomEntityCtor = new (init: CustomEntityInit) => CustomEntity;

/**
 * One custom-entity recipe: which class to instantiate, against which profile,
 * for which absolute base channel(s) of the device.
 */
export interface DeviceConfig {
  readonly entityClass: CustomEntityCtor;
  readonly profile: DeviceProfile;
  readonly channels: readonly number[];
}

/** Normalise a model name: lowercase and fold the `hb-` vendor prefix to `hm-`. */
function normalizeModel(model: string): string {
  return model.toLowerCase().replace('hb-', 'hm-');
}

export class DeviceProfileRegistry {
  readonly #byModel = new Map<string, DeviceConfig[]>();

  /** Register one config under a model key (stored normalised). */
  public register(model: string, config: DeviceConfig): void {
    this.registerMultiple(model, [config]);
  }

  /** Register several configs under a model key, aggregating with any existing. */
  public registerMultiple(model: string, configs: DeviceConfig[]): void {
    const key = normalizeModel(model);
    const existing = this.#byModel.get(key);
    if (existing === undefined) {
      this.#byModel.set(key, [...configs]);
      return;
    }
    this.#byModel.set(key, [...existing, ...configs]);
  }

  /**
   * Resolve the configs for a device type. Exact normalised match takes
   * precedence; otherwise every registered key that is a PREFIX of the
   * normalised model contributes. Returns `[]` when nothing matches.
   */
  public getConfigs(model: string): DeviceConfig[] {
    const normalized = normalizeModel(model);

    const exact = this.#byModel.get(normalized);
    if (exact !== undefined) {
      return [...exact];
    }

    const matches: DeviceConfig[] = [];
    for (const [key, configs] of this.#byModel) {
      if (normalized.startsWith(key)) {
        matches.push(...configs);
      }
    }
    return matches;
  }
}

/** Process-wide singleton registry shared by the family registrations. */
export const deviceProfileRegistry = new DeviceProfileRegistry();
