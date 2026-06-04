/**
 * Profile configuration — declarative description of how a device profile lays
 * its {@link Field}s out across channels. A {@link ChannelGroupConfig} is keyed
 * relative to a base channel; {@link resolve} rebases the relative offsets onto
 * the device's absolute channel indices.
 */

import { Field, type FieldMapping } from './fields.js';

/**
 * Describes the field layout of one profile, relative to a base channel.
 *
 * @property primaryChannel — RELATIVE offset of the entity's primary channel
 *   from the base channel. Defaults to `0`.
 * @property secondaryChannels — additional relative channel offsets that belong
 *   to the same logical entity.
 * @property stateChannelOffset — relative offset of the channel carrying the
 *   primary state (used by some cover/lock profiles).
 * @property fields — field mappings resolved on the primary channel (plus their
 *   own `channelOffset`).
 * @property channelFields — extra field mappings keyed by RELATIVE channel
 *   offset (e.g. heating groups expose LEVEL on offset 0 and STATE on offset 3).
 * @property includeDefaultDataPoints — whether ch0 default data points (battery,
 *   RSSI…) apply. Groups set this to `false`.
 */
export interface ChannelGroupConfig {
  readonly primaryChannel?: number;
  readonly secondaryChannels?: readonly number[];
  readonly stateChannelOffset?: number;
  readonly fields: readonly FieldMapping[];
  readonly channelFields?: Readonly<Record<number, readonly FieldMapping[]>>;
  readonly includeDefaultDataPoints?: boolean;
}

/** A profile config is, for now, a single channel-group config. */
export type ProfileConfig = ChannelGroupConfig;

/** Known device profiles. The value mirrors the key as a stable string. */
export enum DeviceProfile {
  IP_SWITCH = 'IP_SWITCH',
  RF_SWITCH = 'RF_SWITCH',
  IP_DIMMER = 'IP_DIMMER',
  IP_COVER = 'IP_COVER',
  IP_BLIND = 'IP_BLIND',
  IP_THERMOSTAT = 'IP_THERMOSTAT',
  IP_THERMOSTAT_GROUP = 'IP_THERMOSTAT_GROUP',
  RF_THERMOSTAT = 'RF_THERMOSTAT',
  IP_LOCK = 'IP_LOCK',
  RF_LOCK = 'RF_LOCK',
}

/**
 * Static profile → config table. Populated incrementally by the families. Task 2
 * seeds the switch profiles; later tasks add the rest.
 *
 * STATE lives on the entity's primary channel itself (channelOffset 0), so the
 * mapping is the same for IP and RF switches; the registration's base channel
 * selects the right physical channel.
 */
export const PROFILE_CONFIGS: Partial<Record<DeviceProfile, ChannelGroupConfig>> = {
  [DeviceProfile.IP_SWITCH]: {
    primaryChannel: 0,
    fields: [{ field: Field.STATE, parameter: 'STATE' }],
  },
  [DeviceProfile.RF_SWITCH]: {
    primaryChannel: 0,
    fields: [{ field: Field.STATE, parameter: 'STATE' }],
  },
};

/** Resolve a profile config, throwing if the profile has no registered config. */
export function getProfileConfig(profile: DeviceProfile): ChannelGroupConfig {
  const config = PROFILE_CONFIGS[profile];
  if (config === undefined) {
    throw new Error(`No profile config registered for profile: ${profile}`);
  }
  return config;
}
