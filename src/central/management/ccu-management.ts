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
  HmGroupMember,
  HmInstallModeRequest,
  HmInterfaceInfo,
  HmRadioGateway,
  HmServiceMessage,
} from '../../api/types.js';
import { Interface } from '../../support/constants.js';
import { CcuManagementError, ValidationError } from '../../support/errors.js';
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
  /** Current (renewed if needed) session id; `undefined` for session-less clients. */
  readonly getSessionId: () => Promise<string | undefined>;
  /** The XML-RPC client of a configured interface. */
  readonly interfaceClient: (iface: Interface) => ManagementInterfaceClient | undefined;
  /** Interfaces the facade was configured with, in order. */
  readonly configuredInterfaces: () => readonly Interface[];
}

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

const PRODUCT_LABELS: ReadonlyMap<string, string> = new Map([
  ['raspberrymatic', 'RaspberryMatic'],
  ['openccu', 'OpenCCU'],
  ['ccu3', 'CCU3'],
  ['ccu2', 'CCU2'],
]);

function productLabel(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  return PRODUCT_LABELS.get(raw.toLowerCase()) ?? raw;
}

export class CcuManagement {
  private readonly json: RegaPostClient | undefined;
  private readonly getSessionId: () => Promise<string | undefined>;
  private readonly interfaceClient: (iface: Interface) => ManagementInterfaceClient | undefined;
  private readonly configuredInterfaces: () => readonly Interface[];

  public constructor(options: CcuManagementOptions) {
    this.json = options.json;
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
      if (client === undefined || iface !== Interface.BIDCOS_RF) continue;
      const gateways = await this.tryOrNull(() => client.listBidcosInterfaces());
      if (gateways !== null) gatewaysByName.set(entry.name, gateways.map(toGateway));
    }
    const dutyEntries = await this.dutyCycleEntries();
    const knownGatewayAddresses = new Set<string>();
    for (const gws of gatewaysByName.values())
      for (const g of gws) knownGatewayAddresses.add(g.address);

    const result: HmInterfaceInfo[] = [];
    for (const entry of offered) {
      const gateways = gatewaysByName.get(entry.name) ?? [];
      const primary = gateways.find((g) => g.isDefault) ?? gateways[0];
      const connected = primary?.connected ?? (await this.isPresent(entry.name));
      const dutyCycle =
        primary !== undefined
          ? primary.dutyCycle
          : this.dutyCycleFor(entry.name, dutyEntries, knownGatewayAddresses);
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
    return {
      version: version.status === 'fulfilled' ? strOrNull(version.value) : null,
      product: productLabel(release.get('PRODUCT')),
      serial: serial.status === 'fulfilled' ? strOrNull(serial.value) : null,
      hostname,
    };
  }

  // --- groups ------------------------------------------------------------------

  /**
   * The heating groups of the CCU ("Gruppen"), read from `CCU.getHeatingGroupList`
   * (the HMServer's `/etc/config/groups.gson`). `[]` when the CCU has no groups
   * file. Read-only: creating and changing groups stays with the HMServer's
   * WebUI pages; no JSON-RPC / XML-RPC method for it is documented.
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

  /** `Interface.getDutyCycle` (RaspberryMatic/OpenCCU); `null` when the CCU lacks it. */
  private async dutyCycleEntries(): Promise<
    { address: string | null; dutyCycle: number | null }[] | null
  > {
    if (this.json === undefined) return null;
    const raw = await this.tryOrNull(() => this.call(JsonRpcMethod.INTERFACE_GET_DUTY_CYCLE));
    if (!Array.isArray(raw)) return null;
    return asRecordArray(raw).map((entry) => ({
      address: strOrNull(entry['address']),
      dutyCycle: numOrNull(entry['dutyCycle']),
    }));
  }

  /**
   * The HmIP access point is the one duty-cycle entry that does not belong to a
   * BidCos gateway; with zero or several candidates the attribution is unsafe and
   * the answer is `null`.
   */
  private dutyCycleFor(
    name: string,
    entries: { address: string | null; dutyCycle: number | null }[] | null,
    bidcosAddresses: ReadonlySet<string>,
  ): number | null {
    if (entries === null || name !== Interface.HMIP_RF.toString()) return null;
    const rest = entries.filter((e) => e.address === null || !bidcosAddresses.has(e.address));
    return rest.length === 1 ? (rest[0]?.dutyCycle ?? null) : null;
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
