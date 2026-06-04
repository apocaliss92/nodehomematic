/**
 * Public, transport-agnostic types exposed by the library's facade. No internal
 * transport/central types leak through these shapes: a consumer sees only
 * plain, serialisable data + the {@link HmValue} domain.
 */

export type { HmValue } from '../model/converter.js';
import type { HmValue } from '../model/converter.js';

/** A public snapshot of a single data point. */
export interface HmDataPoint {
  /** Stable unique id (the dpk encoded as a lowercased string). */
  readonly id: string;
  /** Parameter name, e.g. `STATE`. */
  readonly parameter: string;
  /** Parameter value type, e.g. `BOOL`, `FLOAT`, `ENUM`. */
  readonly type: string;
  /** Current value (`null` until the first event). */
  readonly value: HmValue;
  readonly unit?: string;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly hasEvents: boolean;
  readonly valueList?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

/** A public snapshot of a single channel. */
export interface HmChannel {
  readonly address: string;
  readonly index: number;
  readonly type?: string;
  readonly dataPoints: HmDataPoint[];
}

/** A public snapshot of a single device. */
export interface HmDevice {
  readonly address: string;
  readonly type: string;
  readonly name?: string;
  readonly rooms?: readonly string[];
  readonly functions?: readonly string[];
  readonly channels: HmChannel[];
}

/**
 * A reference to a data point, accepted by the facade's read/write methods.
 * Either the stable string id, or a structured `{ device, channel, parameter }`
 * locator (channel as the numeric index or full channel address).
 */
export type DataPointRef =
  | string
  | { readonly device: string; readonly channel: number | string; readonly parameter: string };

/**
 * A single device-configuration parameter (MASTER paramset), with the metadata
 * a configuration UI needs to render a form field for it.
 */
export interface HmConfigParam {
  readonly parameter: string;
  readonly type: string;
  readonly min?: number;
  readonly max?: number;
  readonly default?: HmValue;
  readonly unit?: string;
  readonly valueList?: readonly string[];
  /** Raw CCU `FLAGS` bitmask. */
  readonly flags: number;
  /** True when `OPERATIONS & WRITE` is set. */
  readonly writable: boolean;
}

/** The MASTER configuration parameters of a single channel. */
export interface HmChannelConfig {
  readonly channelAddress: string;
  readonly params: HmConfigParam[];
}
