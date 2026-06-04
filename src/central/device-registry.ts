/**
 * Immutable device registry.
 *
 * Holds the device graph keyed by device address and answers lookups used by
 * value routing (channel + parameter resolution by dpk).
 *
 * Immutability choice: per the project's immutability rules, callers only ever
 * see readonly snapshots — {@link DeviceNode}s are deeply readonly and
 * {@link DeviceRegistry.getAll} returns a fresh array copy, so external code
 * cannot mutate registry state. The single, controlled exception is the private
 * internal `Map`, which is mutated copy-on-write per device (`upsert` replaces a
 * whole node, `removeDevice` drops one) — this is the documented performance
 * trade-off versus rebuilding the entire registry object on every change.
 */

import type { DeviceNode, ChannelNode, ParameterSpec } from './graph.js';
import type { DataPointKey } from '../support/dpk.js';

const CHANNEL_SEPARATOR = ':';

export class DeviceRegistry {
  /** Internal address → node map. Never exposed directly. */
  private readonly devices = new Map<string, DeviceNode>();

  /** A snapshot array of all devices (a copy; mutating it is harmless). */
  public getAll(): DeviceNode[] {
    return [...this.devices.values()];
  }

  /** Get a device by its address. */
  public get(address: string): DeviceNode | undefined {
    return this.devices.get(address);
  }

  /**
   * Resolve a channel by its full address (`DEV:idx`). The parent device is
   * found by stripping the last `:`-segment; returns `undefined` for addresses
   * without a channel suffix or for unknown devices/channels.
   */
  public getChannel(channelAddress: string): ChannelNode | undefined {
    const lastColon = channelAddress.lastIndexOf(CHANNEL_SEPARATOR);
    if (lastColon < 0) return undefined;
    const deviceAddress = channelAddress.slice(0, lastColon);
    const device = this.devices.get(deviceAddress);
    if (device === undefined) return undefined;
    return device.channels.find((channel) => channel.address === channelAddress);
  }

  /**
   * Resolve the {@link ParameterSpec} addressed by a dpk: device → channel
   * (`dpk.channelAddress`) → parameter (`dpk.parameter`) → spec for
   * `dpk.paramsetKey`. Returns `undefined` if any hop is missing.
   */
  public resolveParameter(dpk: DataPointKey): ParameterSpec | undefined {
    const channel = this.getChannel(dpk.channelAddress);
    if (channel === undefined) return undefined;
    const specs = channel.parameters.get(dpk.parameter);
    if (specs === undefined) return undefined;
    if (dpk.paramsetKey === 'VALUES') return specs.VALUES;
    if (dpk.paramsetKey === 'MASTER') return specs.MASTER;
    return undefined;
  }

  /** Insert or replace a device (by address). */
  public upsert(device: DeviceNode): void {
    this.devices.set(device.address, device);
  }

  /** Remove a device; its channels are part of the node and go with it. */
  public removeDevice(address: string): void {
    this.devices.delete(address);
  }
}
