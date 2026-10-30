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
  /** Installed firmware version, e.g. `1.18.24` (CCU descriptor `FIRMWARE`). */
  readonly firmware?: string;
  /** Latest firmware available, e.g. `1.18.24` (CCU descriptor `AVAILABLE_FIRMWARE`). */
  readonly availableFirmware?: string;
  /** Whether a firmware update can be installed (CCU descriptor `UPDATABLE`). */
  readonly updatable?: boolean;
  /** Firmware update lifecycle state, e.g. `UP_TO_DATE` (CCU descriptor `FIRMWARE_UPDATE_STATE`). */
  readonly firmwareUpdateState?: string;
  readonly channels: readonly HmChannel[];
}

/**
 * A public snapshot of a CCU system variable (hub layer). Immutable; values are
 * parsed into the {@link HmValue} domain. `writable` reflects the `HAHM`
 * extended-sysvar marker — only writable variables may be set.
 */
export interface HmSysVar {
  readonly id: string;
  readonly name: string;
  /** Normalised value type, e.g. `FLOAT`, `LOGIC`, `LIST`, `STRING`. */
  readonly type: string;
  readonly value: HmValue;
  readonly unit?: string;
  readonly writable: boolean;
  readonly isInternal: boolean;
  readonly valueList?: readonly string[];
  readonly min?: number;
  readonly max?: number;
}

/** A public snapshot of a CCU program (rule/automation). Immutable. */
export interface HmProgram {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly isInternal: boolean;
  readonly lastExecuteTime?: string;
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
  /** The channel this entity is COMMANDED on. */
  readonly channel: string;
  /**
   * Every channel the entity touches, command and status alike.
   *
   * An HmIP cover reports its position on the SHUTTER_TRANSMITTER channel and
   * is commanded on a SHUTTER_VIRTUAL_RECEIVER, so a consumer filtering
   * `valueChanged` by {@link channel} alone drops exactly the reports it wants.
   */
  readonly channels: readonly string[];
  /**
   * The subset of {@link channels} the entity READS from, when that differs
   * from where it is commanded.
   *
   * A consumer watching raw parameter events needs this and not just the
   * union: `LEVEL` exists on BOTH an HmIP cover's channels, so accepting both
   * and taking the last arrival lets the receiver's commanded extreme
   * overwrite the transmitter's real position. Take a parameter from a status
   * channel when it is available there.
   */
  readonly statusChannels: readonly string[];
  /** Position 0..100, or `null` when unavailable. */
  readonly currentPosition: number | null;
  readonly isClosed: boolean;
  /** What the cover is doing right now, from its travel data point. */
  readonly travel: 'opening' | 'closing' | 'stable' | 'unknown';
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

// --- CCU management ---------------------------------------------------------
//
// Shapes for the facade's CCU-management API (interfaces & radio health,
// pairing, device removal, service messages, CCU info, heating groups). A value
// the CCU did not answer is `null`, never `0` / `false` / `''`.

/** One radio gateway behind a BidCos interface (the CCU's own radio or a LAN gateway). */
export interface HmRadioGateway {
  readonly address: string;
  readonly description: string | null;
  /** Duty cycle in percent (0..100), or `null` when not reported. */
  readonly dutyCycle: number | null;
  readonly connected: boolean | null;
  readonly isDefault: boolean;
  readonly firmware: string | null;
  readonly type: string | null;
}

/** A CCU interface (BidCos-RF, HmIP-RF, VirtualDevices, ...) and its radio health. */
export interface HmInterfaceInfo {
  /** Interface name as the CCU spells it, e.g. `HmIP-RF`. */
  readonly name: string;
  /** XML-RPC port of the interface service, or `null` when unknown. */
  readonly port: number | null;
  /** The CCU's short description of the interface, or `null`. */
  readonly info: string | null;
  /** Whether the interface service / radio is reachable; `null` when it could not be told. */
  readonly connected: boolean | null;
  /** Duty cycle in percent (0..100); `null` when the CCU did not report one. */
  readonly dutyCycle: number | null;
  readonly firmware: string | null;
  readonly type: string | null;
  /** Radio gateways (BidCos only; empty for other interfaces). */
  readonly gateways: readonly HmRadioGateway[];
}

/** BidCos pairing flavour: `normal`, or `secure` (also teaches the HomeMatic Secure key). */
export type HmInstallModeKind = 'normal' | 'secure';

/** Input of {@link Homematic.setInstallMode}. */
export interface HmInstallModeRequest {
  /** Interface name, e.g. `HmIP-RF`. Must be one of the facade's configured interfaces. */
  readonly interface: string;
  readonly on: boolean;
  /** Pairing window length in seconds (1..3600, default 60). Ignored when `on` is false. */
  readonly seconds?: number;
  /** BidCos only. Defaults to the CCU's own default (normal). */
  readonly mode?: HmInstallModeKind;
}

/**
 * Bit flags of {@link Homematic.deleteDevice}. OR them together, e.g.
 * `HM_DELETE_FLAGS.RESET | HM_DELETE_FLAGS.FORCE`.
 */
export const HM_DELETE_FLAGS = {
  /** 0x01: reset the device to factory settings while removing it. */
  RESET: 0x01,
  /** 0x02: remove it even when it is not reachable. */
  FORCE: 0x02,
  /** 0x04: remove it the next time it is reachable. */
  DEFER: 0x04,
} as const;

/** A single active service message (`Servicemeldung`). */
export interface HmServiceMessage {
  /** ReGa object id; pass to {@link Homematic.acknowledgeServiceMessage}. */
  readonly id: string;
  /** Name of the alarm object as the CCU shows it, or `null`. */
  readonly name: string | null;
  /** Device address (without the channel), or `null` when the message has no device. */
  readonly address: string | null;
  /** Channel index the message came from (`0` = maintenance), or `null`. */
  readonly channel: number | null;
  /** Message kind, e.g. `UNREACH`, `LOWBAT`, `CONFIG_PENDING`, `STICKY_UNREACH`. */
  readonly type: string | null;
  /** When it came in, epoch milliseconds, or `null` when the CCU reported none. */
  readonly timestamp: number | null;
  /** Whether the CCU lets an operator acknowledge it (sticky messages; the rest clear themselves). */
  readonly acknowledgeable: boolean;
}

/** What the CCU says about itself. Each field is `null` when it did not answer. */
export interface HmCcuInfo {
  /** Firmware version, e.g. `3.75.7`. */
  readonly version: string | null;
  /** Product, e.g. `CCU3`, `RaspberryMatic`, `OpenCCU`. */
  readonly product: string | null;
  readonly serial: string | null;
  readonly hostname: string | null;
}

/** A channel that belongs to a {@link HmGroup}. */
export interface HmGroupMember {
  /** Channel address, e.g. `000A9D89A7AF25:1`. */
  readonly address: string;
  /** Channel type, e.g. `WALLMOUNTED_THERMOSTAT`. */
  readonly type: string;
}

/** A heating group as the WebUI's "Gruppen" page shows it (read-only here). */
export interface HmGroup {
  readonly id: number;
  readonly name: string;
  /** Group type id: `hmip.heating.group` (HmIP) or `HomeMatic.heating`. */
  readonly type: string;
  readonly typeLabel: string | null;
  /** The virtual device that operates the group (`INT0000001`), when named. */
  readonly deviceAddress: string | null;
  readonly forbidSingleOperation: boolean;
  readonly members: readonly HmGroupMember[];
}

/** Input of {@link Homematic.createGroup}. */
export interface HmGroupCreate {
  /** Group name (a `"` is replaced by `'`, as the WebUI does). */
  readonly name: string;
  /** Group type id, e.g. `hmip.heating.group` or `HomeMatic.heating`. */
  readonly type: string;
  /** Member channel addresses, e.g. `000A9D89A7AF25:1`. */
  readonly members: readonly string[];
}

/** Input of {@link Homematic.updateGroup}; at least one field is required. */
export interface HmGroupUpdate {
  readonly name?: string;
  /** The full new member list (not a delta). */
  readonly members?: readonly string[];
}
