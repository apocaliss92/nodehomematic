/**
 * Read-only diagnosis of "why does a HmIP key not deliver PRESS_SHORT to this
 * client?". It only reads; every section is read on its own and a failure is
 * reported in that section (`{ ok: false, error }`), never thrown.
 *
 * What it asks, and where each call comes from:
 * - Central link: XML-RPC `getMetadata(ch, "reportValueUsageData")`, the
 *   `PRESS_SHORT` counter (`central-link.ts`, aiohomematic
 *   `Channel._has_central_link`).
 * - Direct links: `getLinks(ch, 0)` (`central-link.ts`).
 * - Current values and key settings: `getParamset(ch, "VALUES")` and
 *   `getParamset(ch, "MASTER")`, raw.
 * - Device health: the maintenance channel `:0` VALUES `CONFIG_PENDING`,
 *   `UNREACH`, `RSSI_DEVICE`, `RSSI_PEER`, `UPDATE_PENDING`.
 * - ReGa (`../central/rega/key-diagnosis.ts`): the channel objects, their key
 *   data points with `Value()` / `Timestamp()` / `LastTimestamp()`, and the
 *   programs that reference those data points. It needs WebUI credentials;
 *   without them `rega` is `{ available: false, reason }`.
 * - This client: the last time each data point of the key channels and of `:0`
 *   received an event (`GenericDataPoint.lastUpdatedAt`, stamped from the
 *   callback router's `receivedAt`), and per interface the connection state,
 *   the latest event of any kind and whether the callback is considered alive
 *   (`ConnectionStateTracker`).
 *
 * Key channels are the channels of a key type ({@link KEY_CHANNEL_TYPES}) and
 * every channel whose VALUES paramset has `PRESS_SHORT`.
 */
import { interfaceNameOf } from '../central/management/ccu-key-programs.js';
import { KEY_DIAGNOSIS_PARAMETERS } from '../central/rega/key-diagnosis.js';
import type { ConnectionInfo } from '../central/central-unit.js';
import type { ModelChannel } from '../model/channel.js';
import type { ModelDevice } from '../model/device.js';
import { ParamsetKey } from '../support/constants.js';
import type { ParameterData, XmlRpcValue } from '../transport/xmlrpc/types.js';
import {
  GET_LINKS_FLAGS,
  REPORT_VALUE_USAGE_DATA,
  metadataHasCentralLink,
  parseChannelLinks,
} from './central-link.js';
import type {
  HmDiagnosisSection,
  HmKeyCentralLink,
  HmKeyChannelClientState,
  HmKeyChannelDiagnosis,
  HmKeyChannelXmlRpc,
  HmKeyDeviceMaintenance,
  HmKeyEventDiagnosis,
  HmKeyRegaDiagnosis,
  HmKeyRegaState,
  HmParamsetValues,
} from './types.js';

/** Channel types that carry key presses (`KEY_TRANSCEIVER` is the HmIP / HM key channel). */
export const KEY_CHANNEL_TYPES: ReadonlySet<string> = new Set([
  'KEY_TRANSCEIVER',
  'KEY',
  'VIRTUAL_KEY',
]);

/** The reads the diagnosis needs; {@link CentralUnit} and the management service provide them. */
export interface KeyDiagnosisSource {
  getMetadata(interfaceId: string, address: string, dataId: string): Promise<XmlRpcValue>;
  getLinks(interfaceId: string, address: string, flags: number): Promise<XmlRpcValue>;
  readParamset(
    interfaceId: string,
    address: string,
    paramsetKey: ParamsetKey,
  ): Promise<Record<string, unknown>>;
  getParamsetSpec(
    interfaceId: string,
    address: string,
    paramsetKey: ParamsetKey,
  ): Record<string, ParameterData> | undefined;
  getConnectionInfo(interfaceId: string): ConnectionInfo;
  /** The ReGa read; throws when ReGa is unavailable (no WebUI credentials, script failure). */
  readRega(interfaceName: string, channelAddresses: readonly string[]): Promise<HmKeyRegaState>;
  now(): number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function section<T>(read: () => Promise<T>): Promise<HmDiagnosisSection<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (err: unknown) {
    return { ok: false, error: messageOf(err) };
  }
}

function pressShortCount(metadata: XmlRpcValue): number | null {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata) ||
    metadata instanceof Date ||
    metadata instanceof Uint8Array
  ) {
    return null;
  }
  const counter = metadata['PRESS_SHORT'];
  return typeof counter === 'number' ? counter : null;
}

/** Whether `channel` is a key channel: a key type, or a VALUES paramset with `PRESS_SHORT`. */
function isKeyChannel(
  source: KeyDiagnosisSource,
  device: ModelDevice,
  channel: ModelChannel,
): boolean {
  if (channel.type !== undefined && KEY_CHANNEL_TYPES.has(channel.type)) return true;
  if (channel.dataPoint('PRESS_SHORT') !== undefined) return true;
  const spec = source.getParamsetSpec(device.interfaceId, channel.address, ParamsetKey.VALUES);
  return spec !== undefined && 'PRESS_SHORT' in spec;
}

function clientState(
  channel: ModelChannel | undefined,
  address: string,
  withPress: boolean,
): HmKeyChannelClientState {
  const known = new Map((channel?.dataPoints ?? []).map((dp) => [dp.parameter, dp]));
  const press = withPress ? KEY_DIAGNOSIS_PARAMETERS : [];
  const rest = [...known.keys()].filter((parameter) => !press.includes(parameter));
  return {
    channelAddress: address,
    parameters: [...press, ...rest].map((parameter) => {
      const dp = known.get(parameter);
      return {
        parameter,
        known: dp !== undefined,
        lastEventAt: dp?.lastUpdatedAt ?? null,
        value: dp?.value ?? null,
      };
    }),
  };
}

async function readChannelXmlRpc(
  source: KeyDiagnosisSource,
  interfaceId: string,
  address: string,
): Promise<HmKeyChannelXmlRpc> {
  const [centralLink, directLinks, values, master] = await Promise.all([
    section<HmKeyCentralLink>(async () => {
      const metadata = await source.getMetadata(interfaceId, address, REPORT_VALUE_USAGE_DATA);
      return {
        pressShortCount: pressShortCount(metadata),
        active: metadataHasCentralLink(metadata),
      };
    }),
    section(async () =>
      parseChannelLinks(await source.getLinks(interfaceId, address, GET_LINKS_FLAGS)),
    ),
    section<HmParamsetValues>(() => source.readParamset(interfaceId, address, ParamsetKey.VALUES)),
    section<HmParamsetValues>(() => source.readParamset(interfaceId, address, ParamsetKey.MASTER)),
  ]);
  return { centralLink, directLinks, values, master };
}

async function readMaintenance(
  source: KeyDiagnosisSource,
  interfaceId: string,
  address: string,
): Promise<HmDiagnosisSection<HmKeyDeviceMaintenance>> {
  return section(async () => {
    const values = await source.readParamset(interfaceId, address, ParamsetKey.VALUES);
    return {
      channelAddress: address,
      configPending: values['CONFIG_PENDING'] ?? null,
      unreach: values['UNREACH'] ?? null,
      rssiDevice: values['RSSI_DEVICE'] ?? null,
      rssiPeer: values['RSSI_PEER'] ?? null,
      updatePending: values['UPDATE_PENDING'] ?? null,
    };
  });
}

async function readRega(
  source: KeyDiagnosisSource,
  device: ModelDevice,
  keyAddresses: readonly string[],
): Promise<HmKeyRegaDiagnosis> {
  if (keyAddresses.length === 0) return { available: true, state: { channels: [], programs: [] } };
  try {
    const state = await source.readRega(interfaceNameOf(device.interfaceId), keyAddresses);
    return { available: true, state };
  } catch (err: unknown) {
    return { available: false, reason: messageOf(err) };
  }
}

/** Diagnose the key events of `device`; see the file comment. Never throws for a section. */
export async function diagnoseKeyEvents(
  source: KeyDiagnosisSource,
  device: ModelDevice,
): Promise<HmKeyEventDiagnosis> {
  const keyChannels = device.channels.filter((channel) => isKeyChannel(source, device, channel));
  const maintenanceAddress = `${device.address}:0`;
  const [maintenance, channels, rega] = await Promise.all([
    readMaintenance(source, device.interfaceId, maintenanceAddress),
    Promise.all(
      keyChannels.map(async (channel): Promise<HmKeyChannelDiagnosis> => ({
        address: channel.address,
        type: channel.type ?? null,
        xmlRpc: await readChannelXmlRpc(source, device.interfaceId, channel.address),
        client: clientState(channel, channel.address, true),
      })),
    ),
    readRega(
      source,
      device,
      keyChannels.map((channel) => channel.address),
    ),
  ]);
  const info = source.getConnectionInfo(device.interfaceId);
  return {
    deviceAddress: device.address,
    interfaceId: device.interfaceId,
    takenAt: source.now(),
    maintenance,
    maintenanceClient: clientState(device.channel(maintenanceAddress), maintenanceAddress, false),
    channels,
    rega,
    interfaceClient: {
      interfaceId: device.interfaceId,
      state: String(info.state),
      lastEventAt: info.lastEventAt,
      callbackAlive: info.callbackAlive,
    },
  };
}
