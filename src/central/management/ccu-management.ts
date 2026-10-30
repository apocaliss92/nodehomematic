/**
 * CCU management: interfaces & radio health, pairing, service messages, CCU
 * info and heating groups. Pure orchestration over two transports:
 *
 * - the per-interface XML-RPC clients (`listBidcosInterfaces`, `setInstallMode`,
 *   `getInstallMode`), and
 * - the WebUI JSON-RPC client with the library's existing session handling (the
 *   session id is fetched per call through `getSessionId`, so renews apply).
 *
 * Every CCU answer arrives as `unknown` and is narrowed defensively. A value the
 * CCU did not answer is `null`; a failed call is a {@link CcuManagementError}
 * that names the method and keeps the CCU's fault text.
 */
import type {
  HmCcuInfo,
  HmGroup,
  HmGroupCreate,
  HmGroupMember,
  HmGroupUpdate,
  HmInstallModeRequest,
  HmInterfaceInfo,
  HmRadioGateway,
  HmServiceMessage,
} from '../../api/types.js';
import { Interface } from '../../support/constants.js';
import {
  CcuManagementError,
  ClientError,
  GroupWriteVerificationError,
  ValidationError,
} from '../../support/errors.js';
import { jsEscape, type WebUiHttp } from '../../transport/webui/webui-http.js';
import { JsonRpcMethod } from '../../transport/jsonrpc/methods.js';
import type { InstallModeCall, RadioGatewayInfo } from '../../transport/interface-client.js';
import { decodeRegaName, runScript, type RegaPostClient } from '../rega/rega-runner.js';
import {
  ACKNOWLEDGE_SERVICE_MESSAGE,
  GET_CCU_PLATFORM,
  GET_SERVICE_MESSAGES,
} from '../rega/scripts.js';

/** The slice of {@link import('../../transport/interface-client.js').InterfaceClient} used here. */
export interface ManagementInterfaceClient {
  listBidcosInterfaces(): Promise<RadioGatewayInfo[]>;
  setInstallMode(request: InstallModeCall): Promise<void>;
  getInstallModeRemaining(): Promise<number | null>;
}

/** Constructor dependencies. */
export interface CcuManagementOptions {
  /** WebUI JSON-RPC client, or `undefined` without credentials. */
  readonly json: RegaPostClient | undefined;
  /** WebUI HMServer page transport (group writes), or `undefined` without credentials. */
  readonly webUi?: WebUiHttp | undefined;
  /** Current (renewed if needed) session id; `undefined` for session-less clients. */
  readonly getSessionId: () => Promise<string | undefined>;
  /** The XML-RPC client of a configured interface. */
  readonly interfaceClient: (iface: Interface) => ManagementInterfaceClient | undefined;
  /** Interfaces the facade was configured with, in order. */
  readonly configuredInterfaces: () => readonly Interface[];
}

const GROUP_CREATE_PATH = '/pages/jpages/group/create';
const GROUP_SAVE_PATH = '/pages/jpages/group/save';
const GROUP_DELETE_PATH = '/pages/jpages/group/delete';
/** The draft id the `create` page embeds: `self.groupId = 7;` (GroupEditPage.ftl). */
const DRAFT_GROUP_ID = /self\.groupId\s*=\s*(\d+)/;
/** Group types the WebUI offers; any type seen in `groups()` is accepted too. */
const KNOWN_GROUP_TYPES: readonly string[] = ['hmip.heating.group', 'HomeMatic.heating'];
const CHANNEL_ADDRESS = /^[0-9A-Za-z_-]+:\d+$/;
const MAX_GROUP_NAME = 64;
const DEFAULT_INSTALL_SECONDS = 60;
const MAX_INSTALL_SECONDS = 3600;
const SERVICE_MESSAGE_ID = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

const INTERFACES_BY_NAME: ReadonlyMap<string, Interface> = new Map(
  Object.values(Interface).map((iface): [string, Interface] => [iface.toString(), iface]),
);

function toInterface(name: string): Interface {
  const match = INTERFACES_BY_NAME.get(name);
  if (match === undefined) throw new ValidationError(`Unknown interface "${name}".`);
  return match;
}

function toGateway(info: RadioGatewayInfo): HmRadioGateway {
  return { ...info };
}

/** Parse a ReGa `UriEncode`d text and trim it; `null` when empty. */
function decodedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = decodeRegaName(value).trim();
  return text === '' ? null : text;
}

/** `VERSION=3.75.7` style lines → map. */
function parseKeyValueLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

/** Product families derived from the raw `PRODUCT=` value of `/VERSION`. */
const OPENCCU_PRODUCTS: ReadonlySet<string> = new Set(['raspberrymatic', 'openccu', 'ova']);

function productFamily(raw: string | null): HmCcuInfo['productFamily'] {
  if (raw === null) return 'unknown';
  const key = raw.toLowerCase();
  if (key === 'ccu3') return 'ccu3';
  return OPENCCU_PRODUCTS.has(key) ? 'openccu' : 'unknown';
}

export class CcuManagement {
  private readonly json: RegaPostClient | undefined;
  private readonly webUi: WebUiHttp | undefined;
  private readonly getSessionId: () => Promise<string | undefined>;
  private readonly interfaceClient: (iface: Interface) => ManagementInterfaceClient | undefined;
  private readonly configuredInterfaces: () => readonly Interface[];

  public constructor(options: CcuManagementOptions) {
    this.json = options.json;
    this.webUi = options.webUi;
    this.getSessionId = options.getSessionId;
    this.interfaceClient = options.interfaceClient;
    this.configuredInterfaces = options.configuredInterfaces;
  }

  // --- interfaces & radio health ---------------------------------------------

  /**
   * Every interface the CCU offers (JSON-RPC `Interface.listInterfaces`), with
   * connection state, duty cycle and, for BidCos, the radio gateways. Without a
   * JSON-RPC client only the configured interfaces are listed and every probe
   * result is `null`.
   */
  public async listInterfaces(): Promise<HmInterfaceInfo[]> {
    const offered = await this.offeredInterfaces();
    const gatewaysByName = new Map<string, HmRadioGateway[]>();
    for (const entry of offered) {
      const iface = INTERFACES_BY_NAME.get(entry.name);
      const client = iface === undefined ? undefined : this.interfaceClient(iface);
      if (client === undefined || (iface !== Interface.BIDCOS_RF && iface !== Interface.HMIP_RF)) {
        continue;
      }
      const gateways = await this.tryOrNull(() => client.listBidcosInterfaces());
      if (gateways !== null) gatewaysByName.set(entry.name, gateways.map(toGateway));
    }
    const needsFallback = offered.some(
      (e) =>
        e.name === Interface.BIDCOS_RF.toString() &&
        (gatewaysByName.get(e.name) ?? []).every((g) => g.dutyCycle === null),
    );
    const fallbackDuty = needsFallback ? await this.ownRadioDutyCycle() : null;

    const result: HmInterfaceInfo[] = [];
    for (const entry of offered) {
      const gateways = gatewaysByName.get(entry.name) ?? [];
      const primary = gateways.find((g) => g.isDefault) ?? gateways[0];
      const connected = primary?.connected ?? (await this.isPresent(entry.name));
      const dutyCycle =
        primary?.dutyCycle ?? (entry.name === Interface.BIDCOS_RF.toString() ? fallbackDuty : null);
      result.push({
        name: entry.name,
        port: entry.port,
        info: entry.info,
        connected,
        dutyCycle,
        firmware: primary?.firmware ?? null,
        type: primary?.type ?? null,
        gateways,
      });
    }
    return result;
  }

  // --- pairing -----------------------------------------------------------------

  /** Open (default 60 s) or close the pairing window of a configured interface. */
  public async setInstallMode(request: HmInstallModeRequest): Promise<void> {
    const client = this.requireClient(request.interface);
    if (!request.on) {
      await client.setInstallMode({ on: false });
      return;
    }
    const seconds = request.seconds ?? DEFAULT_INSTALL_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_INSTALL_SECONDS) {
      throw new ValidationError(
        `seconds must be an integer between 1 and ${MAX_INSTALL_SECONDS}, got ${String(seconds)}.`,
      );
    }
    const call: InstallModeCall =
      request.mode === undefined
        ? { on: true, seconds }
        : { on: true, seconds, mode: request.mode === 'secure' ? 2 : 1 };
    await client.setInstallMode(call);
  }

  /** Seconds left of the pairing window; `null` when the CCU's answer was unusable. */
  public async getInstallMode(interfaceName: string): Promise<number | null> {
    return this.requireClient(interfaceName).getInstallModeRemaining();
  }

  // --- service messages --------------------------------------------------------

  /** Every active service message (ReGa listing of `ID_SERVICES`). */
  public async serviceMessages(): Promise<HmServiceMessage[]> {
    const raw = await this.rega('ReGa.runScript(serviceMessages)', GET_SERVICE_MESSAGES);
    return asRecordArray(raw).flatMap((entry) => {
      const id = strOrNull(entry['id']);
      if (id === null) return [];
      const address = strOrNull(entry['address']);
      const colon = address === null ? -1 : address.lastIndexOf(':');
      const device = address === null ? null : colon === -1 ? address : address.slice(0, colon);
      const channel = address === null || colon === -1 ? null : numOrNull(address.slice(colon + 1));
      const seconds = numOrNull(entry['timestamp']);
      const message: HmServiceMessage = {
        id,
        name: decodedOrNull(entry['name']),
        address: device,
        channel,
        type: strOrNull(entry['type']),
        timestamp: seconds === null || seconds <= 0 ? null : seconds * 1000,
        acknowledgeable: entry['acknowledgeable'] === true,
      };
      return [message];
    });
  }

  /** Acknowledge one service message by its id. */
  public async acknowledgeServiceMessage(id: string): Promise<void> {
    if (!SERVICE_MESSAGE_ID.test(id)) {
      throw new ValidationError(`Invalid service message id "${id}".`);
    }
    const raw = await this.rega(
      'ReGa.runScript(acknowledgeServiceMessage)',
      ACKNOWLEDGE_SERVICE_MESSAGE,
      {
        id,
      },
    );
    if (!isRecord(raw) || raw['ok'] !== true) {
      throw new ValidationError(`Unknown service message "${id}".`);
    }
  }

  // --- CCU info ----------------------------------------------------------------

  /** Version, product, serial and hostname; each `null` when unanswered. */
  public async ccuInfo(): Promise<HmCcuInfo> {
    const [version, serial, platform] = await Promise.allSettled([
      this.call(JsonRpcMethod.CCU_GET_VERSION),
      this.call(JsonRpcMethod.CCU_GET_SERIAL),
      this.rega('ReGa.runScript(ccuPlatform)', GET_CCU_PLATFORM),
    ]);
    if (
      version.status === 'rejected' &&
      serial.status === 'rejected' &&
      platform.status === 'rejected'
    ) {
      throw version.reason instanceof CcuManagementError
        ? version.reason
        : new CcuManagementError(JsonRpcMethod.CCU_GET_VERSION, version.reason);
    }
    const release =
      platform.status === 'fulfilled' && isRecord(platform.value)
        ? parseKeyValueLines(decodeRegaName(releaseText(platform.value)))
        : new Map<string, string>();
    const hostname =
      platform.status === 'fulfilled' && isRecord(platform.value)
        ? decodedOrNull(platform.value['host'])
        : null;
    const product = strOrNull(release.get('PRODUCT'));
    return {
      version: version.status === 'fulfilled' ? strOrNull(version.value) : null,
      product,
      productFamily: productFamily(product),
      platform: strOrNull(release.get('PLATFORM')),
      serial: serial.status === 'fulfilled' ? strOrNull(serial.value) : null,
      hostname,
    };
  }

  // --- groups ------------------------------------------------------------------

  /**
   * The heating groups of the CCU ("Gruppen"), read from `CCU.getHeatingGroupList`
   * (the HMServer's `/etc/config/groups.gson`). `[]` when the CCU has no groups
   * file. Writes (`createGroup` / `updateGroup` / `deleteGroup`) go through the
   * HMServer's WebUI pages instead, see the group-writes section below.
   */
  public async groups(): Promise<HmGroup[]> {
    const raw = await this.call(JsonRpcMethod.CCU_GET_HEATING_GROUP_LIST);
    if (typeof raw !== 'string' || raw.trim() === '') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CcuManagementError(JsonRpcMethod.CCU_GET_HEATING_GROUP_LIST, err);
    }
    if (!isRecord(parsed)) return [];
    // The groups sit in arrays below the top level; the WebUI walks them without
    // naming the key, so do the same.
    return Object.keys(parsed)
      .sort()
      .flatMap((key) => asRecordArray(parsed[key]))
      .flatMap((entry) => {
        const group = toGroup(entry);
        return group === null ? [] : [group];
      });
  }

  // --- group writes ------------------------------------------------------------
  //
  // WARNING: UNDOCUMENTED and firmware-dependent. There is no JSON-RPC / XML-RPC
  // method for group writes; these calls reproduce what the CCU WebUI's own
  // JavaScript sends to the HMServer pages, copied from eq-3/occu
  //   HMserver/opt/HMServer/pages/GroupEditPage.ftl  (`_SaveGroup`: POST
  //     /pages/jpages/group/save?sid=...)
  //   HMserver/opt/HMServer/pages/GroupListPage.ftl  (`NewGroup`: GET
  //     /pages/jpages/group/create; `removeGroup`: POST /pages/jpages/group/delete)
  // plus the `Interface.setMetadata inHeatingGroup` hints the same page sets.
  // Every write is verified by reading `groups()` back; a mismatch is a
  // GroupWriteVerificationError. Unlike the WebUI, the virtual group device and
  // its channels are not renamed afterwards.

  /** Create a group; resolves with the group as read back from the CCU. */
  public async createGroup(input: HmGroupCreate): Promise<HmGroup> {
    const name = validateGroupName(input.name);
    const members = validateMembers(input.members);
    const before = await this.groups();
    this.validateType(input.type, before);
    const { webUi, sid } = await this.requireWebUi('group/create');

    // The page comes in the HMServer envelope (`=` written as =); a new
    // group's draft id is 0 and the save answers with the id the CCU assigned.
    const page = checkWebUiResponse(GROUP_CREATE_PATH, await webUi.get(GROUP_CREATE_PATH, sid));
    const draft = DRAFT_GROUP_ID.exec(page);
    if (draft === null || draft[1] === undefined) {
      throw new CcuManagementError(GROUP_CREATE_PATH, new ClientError('no group id in the page'));
    }
    const draftId = Number(draft[1]);
    const response = await this.saveGroup(webUi, sid, {
      groupId: draftId,
      groupName: jsEscape(name),
      groupTypeId: input.type,
      forbidSingleOperation: false,
      assignedDevicesIds: members,
      isNewGroup: true,
      // The WebUI sends the (still empty) virtual device serial after the name.
      groupDeviceName: `${name} `,
    });
    const id = numOrNull(response) ?? draftId;
    await this.flagMembers(members, 'true');
    return this.verifyPresent(id, { name, type: input.type, members });
  }

  /** Change a group's name and/or member list; resolves with the group read back. */
  public async updateGroup(id: number, patch: HmGroupUpdate): Promise<HmGroup> {
    if (patch.name === undefined && patch.members === undefined) {
      throw new ValidationError('updateGroup needs a name and/or members.');
    }
    const name = patch.name === undefined ? undefined : validateGroupName(patch.name);
    const members = patch.members === undefined ? undefined : validateMembers(patch.members);
    const current = await this.requireGroup(id);
    const { webUi, sid } = await this.requireWebUi('group/save');

    const nextName = name ?? current.name;
    const nextMembers = members ?? current.members.map((m) => m.address);
    await this.saveGroup(webUi, sid, {
      groupId: id,
      groupName: jsEscape(nextName),
      groupTypeId: current.type,
      forbidSingleOperation: current.forbidSingleOperation,
      assignedDevicesIds: nextMembers,
      isNewGroup: false,
      // The WebUI appends the virtual device serial; a CCU whose groups carry
      // no such suffix (observed on OpenCCU 3.89) keeps the plain name.
      groupDeviceName:
        current.deviceAddress === null ? nextName : `${nextName} ${virtualDeviceSerial(id)}`,
    });
    await this.flagMembers(nextMembers, 'true');
    const kept = new Set(nextMembers);
    await this.flagMembers(
      current.members.map((m) => m.address).filter((a) => !kept.has(a)),
      'false',
    );
    return this.verifyPresent(id, { name: nextName, type: current.type, members: nextMembers });
  }

  /** Delete a group; verified by the group being gone from the read-back. */
  public async deleteGroup(id: number): Promise<void> {
    const current = await this.requireGroup(id);
    const { webUi, sid } = await this.requireWebUi('group/delete');
    const text = await webUi.post(GROUP_DELETE_PATH, sid, JSON.stringify({ groupId: id }));
    checkWebUiResponse(GROUP_DELETE_PATH, text);
    await this.flagMembers(
      current.members.map((m) => m.address),
      'false',
    );
    const after = await this.groups();
    if (after.some((g) => g.id === id)) {
      throw new GroupWriteVerificationError(`Group ${id} is still listed after deleteGroup.`);
    }
  }

  private async requireGroup(id: number): Promise<HmGroup> {
    if (!Number.isInteger(id)) throw new ValidationError(`Invalid group id ${String(id)}.`);
    const found = (await this.groups()).find((g) => g.id === id);
    if (found === undefined) throw new ValidationError(`Unknown group ${id}.`);
    return found;
  }

  private validateType(type: string, existing: readonly HmGroup[]): void {
    const known = new Set<string>([...KNOWN_GROUP_TYPES, ...existing.map((g) => g.type)]);
    if (!known.has(type)) {
      throw new ValidationError(`Unknown group type "${type}" (known: ${[...known].join(', ')}).`);
    }
  }

  private async requireWebUi(label: string): Promise<{ webUi: WebUiHttp; sid: string }> {
    if (this.webUi === undefined) {
      throw new ValidationError(
        `${label} needs WebUI credentials (HMServer pages); none are configured.`,
      );
    }
    const sid = await this.getSessionId();
    if (sid === undefined) {
      throw new ValidationError(`${label} needs a WebUI session.`);
    }
    return { webUi: this.webUi, sid };
  }

  /** POST `group/save`; returns the response `content` (the group id as text). */
  private async saveGroup(
    webUi: WebUiHttp,
    sid: string,
    payload: Record<string, string | number | boolean | string[]>,
  ): Promise<string> {
    const text = await webUi.post(GROUP_SAVE_PATH, sid, JSON.stringify(payload));
    return checkWebUiResponse(GROUP_SAVE_PATH, text);
  }

  /**
   * The WebUI marks every device it puts in / takes out of a heating group with
   * `Interface.setMetadata inHeatingGroup` (its pages use the flag to hide
   * grouped devices). Best effort: the hint is cosmetic and the group itself is
   * verified separately.
   */
  private async flagMembers(addresses: readonly string[], value: 'true' | 'false'): Promise<void> {
    const devices = [...new Set(addresses.map((a) => a.slice(0, a.lastIndexOf(':'))))];
    for (const address of devices) {
      try {
        const objectId = await this.call(JsonRpcMethod.DEVICE_GET_REGA_ID_BY_ADDRESS, { address });
        if (typeof objectId !== 'string' || objectId === '' || objectId === 'noDeviceFound')
          continue;
        await this.call(JsonRpcMethod.INTERFACE_SET_METADATA, {
          objectId,
          dataId: 'inHeatingGroup',
          value,
        });
      } catch {
        // cosmetic hint only
      }
    }
  }

  private async verifyPresent(
    id: number,
    want: { name: string; type: string; members: readonly string[] },
  ): Promise<HmGroup> {
    const found = (await this.groups()).find((g) => g.id === id);
    if (found === undefined) {
      throw new GroupWriteVerificationError(`Group ${id} is not listed after the write.`);
    }
    const have = found.members.map((m) => m.address).sort();
    const expected = [...want.members].sort();
    const sameMembers = have.length === expected.length && have.every((a, i) => a === expected[i]);
    if (found.name !== want.name || found.type !== want.type || !sameMembers) {
      throw new GroupWriteVerificationError(
        `Group ${id} reads back as "${found.name}" (${found.type}, ${have.length} members), ` +
          `expected "${want.name}" (${want.type}, ${expected.length} members).`,
      );
    }
    return found;
  }

  // --- internals ---------------------------------------------------------------

  private requireClient(interfaceName: string): ManagementInterfaceClient {
    const iface = toInterface(interfaceName);
    const client = this.interfaceClient(iface);
    if (client === undefined) {
      throw new ValidationError(`Interface "${interfaceName}" is not configured.`);
    }
    return client;
  }

  private requireJson(method: string): RegaPostClient {
    if (this.json === undefined) {
      throw new ValidationError(
        `${method} needs WebUI credentials (JSON-RPC); none are configured.`,
      );
    }
    return this.json;
  }

  /** A session-bound JSON-RPC call whose failure names the method. */
  private async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const json = this.requireJson(method);
    try {
      const sessionId = await this.getSessionId();
      return await json.post(method, params, sessionId !== undefined ? { sessionId } : undefined);
    } catch (err) {
      throw err instanceof ValidationError ? err : new CcuManagementError(method, err);
    }
  }

  private async rega(
    label: string,
    script: string,
    params?: Record<string, string | number>,
  ): Promise<unknown> {
    const json = this.requireJson(label);
    try {
      const sessionId = await this.getSessionId();
      return await runScript(json, sessionId, script, params);
    } catch (err) {
      throw err instanceof ValidationError ? err : new CcuManagementError(label, err);
    }
  }

  private async tryOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  private async offeredInterfaces(): Promise<
    { name: string; port: number | null; info: string | null }[]
  > {
    if (this.json === undefined) {
      return this.configuredInterfaces().map((iface) => ({
        name: iface,
        port: null,
        info: null,
      }));
    }
    const raw = await this.call(JsonRpcMethod.INTERFACE_LIST_INTERFACES);
    return asRecordArray(raw).flatMap((entry) => {
      const name = strOrNull(entry['name']);
      return name === null
        ? []
        : [{ name, port: numOrNull(entry['port']), info: strOrNull(entry['info']) }];
    });
  }

  private async isPresent(name: string): Promise<boolean | null> {
    if (this.json === undefined) return null;
    const answer = await this.tryOrNull(() =>
      this.call(JsonRpcMethod.INTERFACE_IS_PRESENT, { interface: name }),
    );
    if (typeof answer === 'boolean') return answer;
    if (answer === 'true') return true;
    if (answer === 'false') return false;
    return null;
  }

  /**
   * Fallback when `listBidcosInterfaces` gave no answer: `Interface.getDutyCycle`
   * (RaspberryMatic / OpenCCU) reports the CCU's own radio module as ONE entry
   * with string numbers (`"7"`). It cannot be attributed to HmIP, so it only
   * ever stands in for BidCos-RF; non-numeric or absent is `null`.
   */
  private async ownRadioDutyCycle(): Promise<number | null> {
    if (this.json === undefined) return null;
    const raw = await this.tryOrNull(() => this.call(JsonRpcMethod.INTERFACE_GET_DUTY_CYCLE));
    const entries = asRecordArray(raw);
    return entries.length === 1 ? numOrNull(entries[0]?.['dutyCycle']) : null;
  }
}

function releaseText(value: Record<string, unknown>): string {
  const release = value['release'];
  return typeof release === 'string' ? release : '';
}

const DEVICE_ADDRESS_SUFFIX = /\b(INT\d{7})\s*$/;

function toGroup(entry: Record<string, unknown>): HmGroup | null {
  const id = numOrNull(entry['id']);
  if (id === null) return null;
  const props = isRecord(entry['groupProperties']) ? entry['groupProperties'] : {};
  const groupType = isRecord(entry['groupType']) ? entry['groupType'] : {};
  const deviceName = strOrNull(props['GROUP_DEVICE_NAME']);
  const deviceMatch = deviceName === null ? null : DEVICE_ADDRESS_SUFFIX.exec(deviceName);
  const members: HmGroupMember[] = asRecordArray(entry['groupMembers']).flatMap((m) => {
    const address = strOrNull(m['id']);
    if (address === null) return [];
    const memberType = isRecord(m['memberType']) ? strOrNull(m['memberType']['id']) : null;
    return [{ address, type: memberType ?? '' }];
  });
  return {
    id,
    name: (strOrNull(props['NAME']) ?? '').trim(),
    type: strOrNull(groupType['id']) ?? '',
    typeLabel: strOrNull(groupType['label']),
    deviceAddress: deviceMatch === null ? null : (deviceMatch[1] ?? null),
    forbidSingleOperation: props['FORBID_SINGLE_OPERATION'] === true,
    members,
  };
}

/** `INT` + the id left-padded to 7 digits (`createVirtualDeviceSerialNumber`, viewmodels.js). */
function virtualDeviceSerial(id: number): string {
  return `INT${String(id).padStart(7, '0')}`;
}

function validateGroupName(raw: string): string {
  const name = raw.replace(/"/g, "'").trim();
  if (name === '' || name.length > MAX_GROUP_NAME) {
    throw new ValidationError(`Group name must be 1..${MAX_GROUP_NAME} characters.`);
  }
  return name;
}

function validateMembers(members: readonly string[]): string[] {
  for (const address of members) {
    if (!CHANNEL_ADDRESS.test(address)) {
      throw new ValidationError(`Invalid member channel address "${address}".`);
    }
  }
  return [...new Set(members)];
}

/**
 * Check the HMServer's `{isSuccessful, errorCode, content}` envelope. The
 * content (HTML on failure) is never copied into the error.
 */
function checkWebUiResponse(path: string, text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CcuManagementError(path, new ClientError('response was not JSON'));
  }
  if (!isRecord(parsed) || parsed['isSuccessful'] !== true) {
    const code = isRecord(parsed) ? strOrNull(parsed['errorCode']) : null;
    throw new CcuManagementError(
      path,
      new ClientError(
        code === '42' ? 'session expired (errorCode 42)' : `refused (errorCode ${code ?? 'none'})`,
      ),
    );
  }
  const content = parsed['content'];
  return typeof content === 'string' || typeof content === 'number' ? String(content) : '';
}
