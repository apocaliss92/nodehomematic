/**
 * {@link buildCustomEntities} — turns a {@link ModelDevice} into the typed
 * {@link CustomEntity} views declared for its type in the registry.
 *
 * For each matching {@link DeviceConfig}, and for each absolute base channel it
 * targets, the profile config's field mappings are rebased from relative
 * channel offsets onto the device's absolute channel addresses, resolved to the
 * device's live {@link GenericDataPoint}s, and handed to the entity class. A
 * config that resolves no data points is skipped (defensive).
 */

import type { ModelDevice } from '../device.js';
import type { GenericDataPoint } from '../data-point.js';
import type { CustomEntity, CustomEntityWriter } from './base.js';
import { Field, type FieldMapping } from './fields.js';
import { getProfileConfig, type ChannelGroupConfig } from './profile.js';
import { deviceProfileRegistry, type DeviceConfig } from './registry.js';

/** Build a channel address from a device address and an absolute channel index. */
function channelAddress(deviceAddress: string, channel: number): string {
  return `${deviceAddress}:${channel}`;
}

/**
 * Resolve a set of field mappings against the device, at `baseChannel` plus each
 * mapping's relative `channelOffset`, accumulating into `target`.
 */
function resolveFields(
  device: ModelDevice,
  baseChannel: number,
  mappings: readonly FieldMapping[],
  defaultOffset: number,
  target: Map<Field, GenericDataPoint>,
  readTarget: Map<Field, GenericDataPoint>,
): void {
  for (const mapping of mappings) {
    const offset = mapping.channelOffset ?? defaultOffset;
    const address = channelAddress(device.address, baseChannel + offset);
    const dp = device.dataPoint(address, mapping.parameter);
    if (dp !== undefined) {
      target.set(mapping.field, dp);
    }
    // A field READ somewhere else than it is commanded (see
    // `FieldMapping.readChannelOffset`). Resolved independently: a device
    // whose transmitter channel is missing still gets its command binding,
    // and vice versa — one absent half must not cost the other.
    if (mapping.readChannelOffset === undefined) continue;
    const readAddress = channelAddress(device.address, baseChannel + mapping.readChannelOffset);
    const readDp = device.dataPoint(readAddress, mapping.parameter);
    if (readDp !== undefined) {
      readTarget.set(mapping.field, readDp);
    }
  }
}

/** Build the Field→GenericDataPoint map for one config at one base channel. */
function buildDataPoints(
  device: ModelDevice,
  baseChannel: number,
  profileConfig: ChannelGroupConfig,
): { dataPoints: Map<Field, GenericDataPoint>; readDataPoints: Map<Field, GenericDataPoint> } {
  const dataPoints = new Map<Field, GenericDataPoint>();
  const readDataPoints = new Map<Field, GenericDataPoint>();

  resolveFields(device, baseChannel, profileConfig.fields, 0, dataPoints, readDataPoints);

  if (profileConfig.channelFields !== undefined) {
    for (const [offsetKey, mappings] of Object.entries(profileConfig.channelFields)) {
      const offset = Number(offsetKey);
      resolveFields(device, baseChannel, mappings, offset, dataPoints, readDataPoints);
    }
  }

  return { dataPoints, readDataPoints };
}

/** Build all custom entities declared for `device`, wired to `writer`. */
export function buildCustomEntities(
  device: ModelDevice,
  writer: CustomEntityWriter,
): CustomEntity[] {
  const configs: DeviceConfig[] = deviceProfileRegistry.getConfigs(device.type);
  const entities: CustomEntity[] = [];

  for (const config of configs) {
    const profileConfig = getProfileConfig(config.profile);
    const primaryOffset = profileConfig.primaryChannel ?? 0;

    for (const baseChannel of config.channels) {
      const { dataPoints, readDataPoints } = buildDataPoints(device, baseChannel, profileConfig);
      if (dataPoints.size === 0) {
        continue;
      }
      const primaryChannelAddress = channelAddress(device.address, baseChannel + primaryOffset);
      entities.push(
        new config.entityClass({
          deviceAddress: device.address,
          primaryChannelAddress,
          type: device.type,
          dataPoints,
          readDataPoints,
          writer,
        }),
      );
    }
  }

  return entities;
}
