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
  /**
   * CCU user-given channel name from JSON-RPC `Device.listAllDetail`.
   * `null` when the CCU has none or the name read failed — never the address.
   */
  readonly name: string | null;
  readonly dataPoints: readonly HmDataPoint[];
}

/** One direct device link from XML-RPC `getLinks` (`SENDER` / `RECEIVER` / `NAME`). */
export interface HmChannelLink {
  readonly sender: string;
  readonly receiver: string;
  readonly name: string;
}

/**
 * Central-link flag plus the direct links of one channel.
 * `central` is `getMetadata("reportValueUsageData").PRESS_SHORT > 0`, not a
 * peer inside `links`.
 */
export interface HmChannelLinkState {
  readonly central: boolean;
  readonly links: readonly HmChannelLink[];
}

/**
 * What one key press does on a switch actuator link. `none` is
 * `PROFILE_ACTION_TYPE_INACTIVE` (the press is ignored).
 */
export type HmLinkPressAction = 'toggle' | 'on' | 'off' | 'none';

/** The short and long press actions of a key → switch actuator link. */
export interface HmSwitchLinkActions {
  readonly short: HmLinkPressAction;
  readonly long: HmLinkPressAction;
}

/** A link whose receiver paramset matches the switch catalogue exactly. */
export interface HmSwitchLinkProfile extends HmSwitchLinkActions {
  readonly kind: 'switch';
}

/**
 * A key → switch link whose receiver paramset matches no catalogue profile
 * (a timer, a delay, an expert setting). It is never rewritten by
 * `setLinkProfile`.
 */
export interface HmCustomLinkProfile {
  readonly kind: 'custom';
}

/** The resolved profile of a key → switch actuator link. */
export type HmLinkProfile = HmSwitchLinkProfile | HmCustomLinkProfile;

/** One direct link with its CCU name, description and resolved profile. */
export interface HmLink {
  readonly sender: string;
  readonly receiver: string;
  /** `NAME` from `getLinks`; `""` when the CCU sent none. */
  readonly name: string;
  /** `DESCRIPTION` from `getLinks` verbatim; `""` when the CCU sent none. */
  readonly description: string;
  /**
   * The switch profile, or `null` when the link is not a `KEY_TRANSCEIVER` →
   * `SWITCH_VIRTUAL_RECEIVER` link between two known channels (no catalogue
   * applies).
   */
  readonly profile: HmLinkProfile | null;
}

/** A device or channel address with the name the CCU now holds for it. */
export interface HmNamedObject {
  readonly address: string;
  readonly name: string;
}

/** Options of `renameDevice`. */
export interface HmRenameDeviceOptions {
  /** Also rename every channel to `<name>:<channelIndex>`. */
  readonly renameChannels: boolean;
}

/** The names the CCU applied after `renameDevice` (it may adjust them to stay unique). */
export interface HmDeviceRename {
  readonly device: HmNamedObject;
  /** Renamed channels; empty when `renameChannels` was `false`. */
  readonly channels: readonly HmNamedObject[];
}

/** A CCU room with its member channels. */
export interface HmRoom {
  /** ReGa object id of the room. */
  readonly id: string;
  readonly name: string;
  /** Member channel addresses (`DEVICE:index`). */
  readonly channels: readonly string[];
}

/** Key press parameters a key event program listens to. */
export type HmKeyEventParameter = 'PRESS_SHORT' | 'PRESS_LONG';

/** Input of {@link Homematic.ensureKeyEventProgram}. */
export interface HmKeyEventProgramInput {
  /** Program name; the program is found by it. */
  readonly name: string;
  /** Key channels (`DEV:1`), all on one interface. */
  readonly channelAddresses: readonly string[];
  /** Defaults to `PRESS_SHORT` and `PRESS_LONG`. */
  readonly parameters?: readonly HmKeyEventParameter[];
}

/** Result of {@link Homematic.ensureKeyEventProgram}. */
export interface HmKeyEventProgramResult {
  readonly programId: string;
  /** `true` when the program did not exist before. */
  readonly created: boolean;
}

/** A key event program as found on the CCU. */
export interface HmKeyEventProgram {
  readonly programId: string;
  readonly channelAddresses: string[];
}

// --- key event diagnosis -------------------------------------------------------

/**
 * One section of {@link HmKeyEventDiagnosis}. A section that could not be read
 * is `{ ok: false, error }`; it never fails the whole diagnosis.
 */
export type HmDiagnosisSection<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

/** A VALUES / MASTER paramset as the interface returned it (parameter name -> raw value). */
export type HmParamsetValues = Readonly<Record<string, unknown>>;

/** Central link of one channel: XML-RPC `getMetadata(ch, "reportValueUsageData")`. */
export interface HmKeyCentralLink {
  /** The `PRESS_SHORT` usage counter, or `null` when the metadata has none. */
  readonly pressShortCount: number | null;
  /** `pressShortCount > 0` (aiohomematic `Channel._has_central_link`). */
  readonly active: boolean;
}

/** The device's maintenance channel (`:0`) values that tell whether it is reachable and configured. */
export interface HmKeyDeviceMaintenance {
  /** Address of the maintenance channel, `<device>:0`. */
  readonly channelAddress: string;
  /** `null` when the parameter is absent from the answer. */
  readonly configPending: unknown;
  readonly unreach: unknown;
  readonly rssiDevice: unknown;
  readonly rssiPeer: unknown;
  readonly updatePending: unknown;
}

/** What THIS client received for one parameter, from the library's own data points. */
export interface HmKeyParameterClientState {
  readonly parameter: string;
  /** Whether the library has a data point for it. */
  readonly known: boolean;
  /** Epoch ms of the last event applied to the data point, `null` when none arrived. */
  readonly lastEventAt: number | null;
  /** The data point's current value (`null` until the first event). */
  readonly value: unknown;
}

/** Events THIS client received for one channel. */
export interface HmKeyChannelClientState {
  readonly channelAddress: string;
  /** `PRESS_SHORT`, `PRESS_LONG`, `PRESS_LONG_RELEASE` first, then every other data point. */
  readonly parameters: readonly HmKeyParameterClientState[];
}

/** XML-RPC view of one key channel. */
export interface HmKeyChannelXmlRpc {
  readonly centralLink: HmDiagnosisSection<HmKeyCentralLink>;
  /** `getLinks(ch, 0)`. */
  readonly directLinks: HmDiagnosisSection<readonly HmChannelLink[]>;
  /** `getParamset(ch, "VALUES")`. */
  readonly values: HmDiagnosisSection<HmParamsetValues>;
  /** `getParamset(ch, "MASTER")`, raw: the key settings. */
  readonly master: HmDiagnosisSection<HmParamsetValues>;
}

/** One key channel in {@link HmKeyEventDiagnosis}. */
export interface HmKeyChannelDiagnosis {
  readonly address: string;
  /** Channel type from the device description, e.g. `KEY_TRANSCEIVER`. */
  readonly type: string | null;
  readonly xmlRpc: HmKeyChannelXmlRpc;
  readonly client: HmKeyChannelClientState;
}

/** One ReGa data point of a key channel (`<iface>.<addr>:<n>.PRESS_SHORT` ...). */
export interface HmKeyRegaDatapoint {
  /** The ReGa name, `<interface>.<channel address>.<PARAM>`. */
  readonly name: string;
  /** Whether the CCU has such a data point; `false` is why no program can use it. */
  readonly exists: boolean;
  readonly id: string | null;
  /** `Value()` as ReGa prints it (a boolean is `"true"` / `"false"`). */
  readonly value: string | null;
  /** `Timestamp()` as epoch ms: the last time the CCU UPDATED the data point (any event, even an unchanged value). */
  readonly timestamp: number | null;
  /** `LastTimestamp()` as epoch ms: the update before `timestamp`. */
  readonly lastTimestamp: number | null;
}

/** The ReGa channel object of a key channel and its key data points. */
export interface HmKeyRegaChannel {
  readonly address: string;
  /** `false` when ReGa has no channel with that address. */
  readonly found: boolean;
  readonly id: string | null;
  readonly name: string | null;
  readonly visible: boolean | null;
  /** `Enabled()`; `null` when ReGa answered nothing. */
  readonly enabled: boolean | null;
  /** `ReadyConfig()`; `null` when ReGa answered nothing. */
  readonly readyConfig: boolean | null;
  /** `LastDPActionTime`: the last time any data point of the channel was acted on, epoch ms. */
  readonly lastActionAt: number | null;
  readonly datapoints: readonly HmKeyRegaDatapoint[];
}

/** A CCU program whose condition references one of the key data points. */
export interface HmKeyRegaProgram {
  readonly id: string;
  readonly name: string;
  readonly active: boolean | null;
  /** `Internal()`: a system program the WebUI hides. */
  readonly internal: boolean | null;
  /** `ProgramLastExecuteTime`, epoch ms; `null` when it never ran. */
  readonly lastExecutedAt: number | null;
  /** The key data point names its conditions reference. */
  readonly datapoints: readonly string[];
}

/** A CCU program whose conditions reference key channels, from {@link Homematic.keyProgramReferences}. */
export interface HmKeyProgramReference {
  readonly id: string;
  readonly name: string;
  /** `Active()`; `null` when ReGa answered nothing. */
  readonly active: boolean | null;
  /** The key channel addresses (`<device>:<n>`) the conditions reference, each once. */
  readonly channels: readonly string[];
}

/** What the CCU's ReGa knows about the key channels. */
export interface HmKeyRegaState {
  readonly channels: readonly HmKeyRegaChannel[];
  /** Empty when no program references a key data point. */
  readonly programs: readonly HmKeyRegaProgram[];
}

/** The ReGa part of the diagnosis: unavailable (no WebUI credentials, script failure) or read. */
export type HmKeyRegaDiagnosis =
  | { readonly available: true; readonly state: HmKeyRegaState }
  | { readonly available: false; readonly reason: string };

/** Connection health of the device's interface, from the library's own tracker. */
export interface HmKeyInterfaceClientState {
  readonly interfaceId: string;
  /** Connection state, e.g. `CONNECTED`. */
  readonly state: string;
  /** Epoch ms of the latest event of ANY kind received on the interface, `null` when none. */
  readonly lastEventAt: number | null;
  /** The callback is alive: no silence beyond the warn interval. */
  readonly callbackAlive: boolean;
}

/** Result of {@link Homematic.diagnoseKeyEvents}. */
export interface HmKeyEventDiagnosis {
  readonly deviceAddress: string;
  readonly interfaceId: string;
  /** Epoch ms the diagnosis was taken. */
  readonly takenAt: number;
  /** The maintenance channel `:0` over XML-RPC. */
  readonly maintenance: HmDiagnosisSection<HmKeyDeviceMaintenance>;
  /** Events this client received on the maintenance channel. */
  readonly maintenanceClient: HmKeyChannelClientState;
  /** Key channels found on the device (empty when it has none). */
  readonly channels: readonly HmKeyChannelDiagnosis[];
  /** ReGa data points and programs for the key channels. */
  readonly rega: HmKeyRegaDiagnosis;
  readonly interfaceClient: HmKeyInterfaceClientState;
}

/** A public snapshot of a single device. */

export interface HmDevice {
  readonly address: string;
  readonly type: string;
  /**
   * CCU user-given device name from JSON-RPC `Device.listAllDetail`.
   * `null` when the CCU has none or the name read failed — never the address.
   */
  readonly name: string | null;
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
  /** Raw `PRODUCT=` of the CCU's `/VERSION`, e.g. `ccu3`, `raspberrymatic`, `ova` (OpenCCU as a VM). */
  readonly product: string | null;
  /** Derived family: `ccu3`, `openccu` (OpenCCU / RaspberryMatic, any platform) or `unknown`. */
  readonly productFamily: 'ccu3' | 'openccu' | 'unknown';
  /** Raw `PLATFORM=` of `/VERSION`, e.g. `ova`, `rpi4`. */
  readonly platform: string | null;
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
