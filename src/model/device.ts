/**
 * {@link ModelDevice} — a public, structurally-immutable view of one device. It
 * groups the device's {@link ModelChannel}s and exposes by-channel and
 * by-(channel, parameter) lookups plus a flattened data-point listing. Identity
 * and structure are fixed at construction; the data points carry live state.
 */

import type { ModelChannel } from './channel.js';
import type { GenericDataPoint } from './data-point.js';

/** Construction inputs for a {@link ModelDevice}. */
export interface ModelDeviceInit {
  readonly address: string;
  readonly type: string;
  readonly interfaceId: string;
  readonly name?: string;
  readonly rooms?: readonly string[];
  readonly functions?: readonly string[];
  /** Installed firmware version, e.g. `1.18.24`. */
  readonly firmware?: string;
  /** Latest firmware available for this device, e.g. `1.18.24`. */
  readonly availableFirmware?: string;
  /** Whether a firmware update can be installed for this device. */
  readonly updatable?: boolean;
  /** Firmware update lifecycle state, e.g. `UP_TO_DATE`. */
  readonly firmwareUpdateState?: string;
  readonly channels: readonly ModelChannel[];
}

export class ModelDevice {
  public readonly address: string;
  public readonly type: string;
  public readonly interfaceId: string;
  public readonly name?: string;
  public readonly rooms?: readonly string[];
  public readonly functions?: readonly string[];
  public readonly firmware?: string;
  public readonly availableFirmware?: string;
  public readonly updatable?: boolean;
  public readonly firmwareUpdateState?: string;
  public readonly channels: readonly ModelChannel[];

  readonly #byAddress: ReadonlyMap<string, ModelChannel>;

  public constructor(init: ModelDeviceInit) {
    this.address = init.address;
    this.type = init.type;
    this.interfaceId = init.interfaceId;
    if (init.name !== undefined) {
      this.name = init.name;
    }
    if (init.rooms !== undefined) {
      this.rooms = init.rooms;
    }
    if (init.functions !== undefined) {
      this.functions = init.functions;
    }
    if (init.firmware !== undefined) {
      this.firmware = init.firmware;
    }
    if (init.availableFirmware !== undefined) {
      this.availableFirmware = init.availableFirmware;
    }
    if (init.updatable !== undefined) {
      this.updatable = init.updatable;
    }
    if (init.firmwareUpdateState !== undefined) {
      this.firmwareUpdateState = init.firmwareUpdateState;
    }
    this.channels = init.channels;
    this.#byAddress = new Map(init.channels.map((ch) => [ch.address, ch]));
  }

  /** Resolve a channel by its full channel address (e.g. `VCU0000001:1`). */
  public channel(channelAddress: string): ModelChannel | undefined {
    return this.#byAddress.get(channelAddress);
  }

  /** Resolve a data point by channel address and parameter name. */
  public dataPoint(channelAddress: string, parameter: string): GenericDataPoint | undefined {
    return this.channel(channelAddress)?.dataPoint(parameter);
  }

  /** All data points across every channel, flattened into a single array. */
  public allDataPoints(): GenericDataPoint[] {
    return this.channels.flatMap((ch) => [...ch.dataPoints]);
  }
}
