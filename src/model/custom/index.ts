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
import { DimmerEntity } from './light.js';
import { CoverEntity, BlindEntity } from './cover.js';
import { IpLockEntity, RfLockEntity } from './lock.js';

deviceProfileRegistry.register('HmIP-PS', {
  entityClass: SwitchEntity,
  profile: DeviceProfile.IP_SWITCH,
  channels: [3],
});

// AUDIT, 2026-09-24, against this CCU's own `listDevices`: the
// TRANSMITTER / VIRTUAL_RECEIVER split is the HmIP convention across every
// family, not a cover quirk.
//
//   HmIP-BROLL   3:SHUTTER_TRANSMITTER   4,5,6:SHUTTER_VIRTUAL_RECEIVER
//   HmIP-BSM     3:SWITCH_TRANSMITTER    4,5,6:SWITCH_VIRTUAL_RECEIVER
//   HmIP-BS2     3,7:SWITCH_TRANSMITTER  4,5,6 + 8,9,10:SWITCH_VIRTUAL_RECEIVER
//   HmIP-BWTH    9:SWITCH_TRANSMITTER    10,11,12:SWITCH_VIRTUAL_RECEIVER
//
// The switch registrations below therefore READ the receiver too. Measured on
// five live relays (BS2 ×2 incl. its second circuit, BSM ×2), transmitter and
// receiver agreed on every one: a relay is instantaneous, so the commanded
// value and the reported value converge and the misalignment is INVISIBLE.
// It is not absent — a relay switched at the wall, or one that fails to
// follow, is known to the transmitter and not to the receiver — but it is not
// something this checkout can demonstrate, so the registrations are left as
// they are rather than changed on a symmetry argument.
//
// The DIMMER case is the one to watch: `HmIP-BDT` is registered on channel 4
// and a dimmer's LEVEL ramps exactly as a cover's does, so it is likely wrong
// in the same measurable way. There is no BDT on this CCU to prove it on.
deviceProfileRegistry.register('HmIP-BSM', {
  entityClass: SwitchEntity,
  profile: DeviceProfile.IP_SWITCH,
  channels: [4],
});

// HmIP-BS2: dual brand-switch actuator. Live layout (real CCU): ch1-2
// KEY_TRANSCEIVER, ch3/ch7 SWITCH_TRANSMITTER read-back, ch4-6/ch8-10
// SWITCH_VIRTUAL_RECEIVER — one relay per group, primary = the first
// VIRTUAL_RECEIVER of each (4 and 8).
deviceProfileRegistry.register('HmIP-BS2', {
  entityClass: SwitchEntity,
  profile: DeviceProfile.IP_SWITCH,
  channels: [4, 8],
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

// --- Light / Dimmer ---
// HmIP dimmers carry LEVEL on a dedicated virtual-receiver channel: brand-mount
// dimmer (BDT) ch4, flush-mount (FDT) ch2, plug dimmer (PDT) ch3.
deviceProfileRegistry.register('HmIP-BDT', {
  entityClass: DimmerEntity,
  profile: DeviceProfile.IP_DIMMER,
  channels: [4],
});
deviceProfileRegistry.register('HmIP-FDT', {
  entityClass: DimmerEntity,
  profile: DeviceProfile.IP_DIMMER,
  channels: [2],
});
deviceProfileRegistry.register('HmIP-PDT', {
  entityClass: DimmerEntity,
  profile: DeviceProfile.IP_DIMMER,
  channels: [3],
});
// Classic RF dimmers expose LEVEL on channel 1.
deviceProfileRegistry.register('HM-LC-Dim', {
  entityClass: DimmerEntity,
  profile: DeviceProfile.RF_DIMMER,
  channels: [1],
});

// --- Cover / Blind ---
// HmIP roller shutters (BROLL/FROLL) and blinds (BBL/FBL) are COMMANDED on the
// virtual-receiver channel 4 and REPORT on the transmitter channel 3. The
// profile carries that split (`readChannelOffset`); the registration names the
// command channel, which is the one a write must reach.
deviceProfileRegistry.register('HmIP-BROLL', {
  entityClass: CoverEntity,
  profile: DeviceProfile.IP_COVER,
  channels: [4],
});
deviceProfileRegistry.register('HmIP-FROLL', {
  entityClass: CoverEntity,
  profile: DeviceProfile.IP_COVER,
  channels: [4],
});
deviceProfileRegistry.register('HmIP-BBL', {
  entityClass: BlindEntity,
  profile: DeviceProfile.IP_BLIND,
  channels: [4],
});
deviceProfileRegistry.register('HmIP-FBL', {
  entityClass: BlindEntity,
  profile: DeviceProfile.IP_BLIND,
  channels: [4],
});
// Classic RF blind/shutter actuators expose the cover on channel 1.
deviceProfileRegistry.register('HM-LC-Bl1', {
  entityClass: CoverEntity,
  profile: DeviceProfile.RF_COVER,
  channels: [1],
});

// --- Lock ---
// HmIP door-lock drive (DLD) carries LOCK_STATE/LOCK_TARGET_LEVEL on channel 1.
deviceProfileRegistry.register('HmIP-DLD', {
  entityClass: IpLockEntity,
  profile: DeviceProfile.IP_LOCK,
  channels: [1],
});
// Classic RF key/lock (HM-Sec-Key) exposes STATE/OPEN on channel 1.
deviceProfileRegistry.register('HM-Sec-Key', {
  entityClass: RfLockEntity,
  profile: DeviceProfile.RF_LOCK,
  channels: [1],
});

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
export { DimmerEntity } from './light.js';
export { CoverEntity, BlindEntity } from './cover.js';
export { IpLockEntity, RfLockEntity } from './lock.js';
export { DeviceProfile, getProfileConfig } from './profile.js';
export { deviceProfileRegistry, type DeviceConfig } from './registry.js';
