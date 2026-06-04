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
  readonly dataPoints: readonly HmDataPoint[];
}

/** A public snapshot of a single device. */
export interface HmDevice {
  readonly address: string;
  readonly type: string;
  readonly name?: string;
  readonly rooms?: readonly string[];
  readonly functions?: readonly string[];
  readonly channels: readonly HmChannel[];
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

// --- Custom entities (typed domain views over generic data points) ----------
//
// A custom entity aggregates several data points of one device into a typed
// domain object (Climate / Switch / Light / Cover / Lock). These snapshot types
// carry only plain, serialisable state — never functions; commands are issued
// through the facade's ergonomic command methods (e.g. `climateSetTemperature`).

/** A climate (thermostat / heating-group) snapshot. */
export interface HmClimate {
  readonly kind: 'climate';
  /** Owning device address, e.g. `VCU0000001`. */
  readonly device: string;
  /** Primary channel address, e.g. `VCU0000001:1`. */
  readonly channel: string;
  readonly currentTemperature: number | null;
  readonly targetTemperature: number | null;
  readonly currentHumidity: number | null;
  readonly minTemp: number;
  readonly maxTemp: number;
  readonly targetTemperatureStep: number;
  readonly mode: 'auto' | 'heat' | 'off';
  readonly preset: 'boost' | 'away' | 'week_program' | 'none';
  readonly activity: 'heating' | 'idle' | 'off';
}

/** An on/off switch snapshot. */
export interface HmSwitch {
  readonly kind: 'switch';
  readonly device: string;
  readonly channel: string;
  readonly isOn: boolean;
}

/** A dimmable light snapshot. */
export interface HmLight {
  readonly kind: 'light';
  readonly device: string;
  readonly channel: string;
  readonly isOn: boolean;
  /** Brightness 0..255, or `null` when unavailable. */
  readonly brightness: number | null;
}

/** A cover/blind snapshot. */
export interface HmCover {
  readonly kind: 'cover' | 'blind';
  readonly device: string;
  readonly channel: string;
  /** Position 0..100, or `null` when unavailable. */
  readonly currentPosition: number | null;
  readonly isClosed: boolean;
  /** Slat tilt 0..100 (blinds only), or `null` when unavailable. */
  readonly currentTiltPosition?: number | null;
}

/** A lock snapshot. */
export interface HmLock {
  readonly kind: 'lock';
  readonly device: string;
  readonly channel: string;
  readonly isLocked: boolean;
}

/**
 * A custom-entity snapshot — a discriminated union keyed by `kind`. An immutable
 * view of the entity's current state; issue commands through the facade methods.
 */
export type HmCustomEntity = HmClimate | HmSwitch | HmLight | HmCover | HmLock;
