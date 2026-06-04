/**
 * Custom-entity public surface + family registrations. Importing this module
 * registers the built-in families with the singleton registry as a side effect.
 *
 * Each registration declares the absolute base channel(s) the entity occupies:
 * HmIP switch state lives on a dedicated channel (PS=3, BSM=4), while classic RF
 * switches expose STATE on channel 1.
 */

import { deviceProfileRegistry } from './registry.js';
import { DeviceProfile } from './profile.js';
import { SwitchEntity } from './switch.js';
import { ClimateEntity } from './climate.js';

deviceProfileRegistry.register('HmIP-PS', {
  entityClass: SwitchEntity,
  profile: DeviceProfile.IP_SWITCH,
  channels: [3],
});

deviceProfileRegistry.register('HmIP-BSM', {
  entityClass: SwitchEntity,
  profile: DeviceProfile.IP_SWITCH,
  channels: [4],
});

deviceProfileRegistry.register('HM-LC-Sw', {
  entityClass: SwitchEntity,
  profile: DeviceProfile.RF_SWITCH,
  channels: [1],
});

// --- Climate (IP thermostats + heating groups) ---

// HmIP-HEATING: virtual heating group. Same IP-thermostat semantics, but the
// group profile reads valve LEVEL/STATE from channels relative to base 1
// (offset 0 → ch1 LEVEL, offset 3 → ch4 STATE) and has no ch0 default points.
deviceProfileRegistry.register('HmIP-HEATING', {
  entityClass: ClimateEntity,
  profile: DeviceProfile.IP_THERMOSTAT_GROUP,
  channels: [1],
});

// Radiator thermostats.
deviceProfileRegistry.register('HmIP-eTRV', {
  entityClass: ClimateEntity,
  profile: DeviceProfile.IP_THERMOSTAT,
  channels: [1],
});

// Wall thermostats.
deviceProfileRegistry.register('HmIP-WTH', {
  entityClass: ClimateEntity,
  profile: DeviceProfile.IP_THERMOSTAT,
  channels: [1],
});
deviceProfileRegistry.register('HmIP-BWTH', {
  entityClass: ClimateEntity,
  profile: DeviceProfile.IP_THERMOSTAT,
  channels: [1],
});

// Temperature/humidity room thermostats. `HmIP-STH` is a prefix of `HmIP-STHD`
// (and `HmIP-STHO` etc.), so a single registration covers the whole STH family
// without producing duplicate entities for the longer variants.
deviceProfileRegistry.register('HmIP-STH', {
  entityClass: ClimateEntity,
  profile: DeviceProfile.IP_THERMOSTAT,
  channels: [1],
});

// TODO: valve actuator family — HmIP-FALMOT-C12 is a multi-channel valve
// actuator (12 channels), NOT a single thermostat. Registering it as a
// ClimateEntity would mis-resolve, so it intentionally stays generic for now.

export { Field } from './fields.js';
export { CustomEntity, type CustomEntityWriter, type CustomEntityInit } from './base.js';
export { buildCustomEntities } from './resolve.js';
export { SwitchEntity } from './switch.js';
export {
  ClimateEntity,
  type ClimateMode,
  type ClimatePreset,
  type ClimateActivity,
} from './climate.js';
export { DeviceProfile, getProfileConfig } from './profile.js';
export { deviceProfileRegistry, type DeviceConfig } from './registry.js';
