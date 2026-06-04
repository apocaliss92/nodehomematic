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

export { Field } from './fields.js';
export { CustomEntity, type CustomEntityWriter, type CustomEntityInit } from './base.js';
export { buildCustomEntities } from './resolve.js';
export { SwitchEntity } from './switch.js';
export { DeviceProfile, getProfileConfig } from './profile.js';
export { deviceProfileRegistry, type DeviceConfig } from './registry.js';
