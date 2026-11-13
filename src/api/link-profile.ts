/**
 * Direct links and the switch-actuator link profile catalogue.
 *
 * Protocol (HomeMatic XML-RPC, as forwarded by the WebUI in eq-3/occu
 * `WebUI/www/api/methods/interface/addlink.tcl` and `removelink.tcl`):
 *
 *   addLink(sender, receiver, name, description)
 *   removeLink(sender, receiver)
 *   getLinks(address, 0)            → [{SENDER, RECEIVER, NAME, DESCRIPTION, FLAGS, …}]
 *   getParamset(receiver, sender)   → the RECEIVER's link paramset for that sender
 *   putParamset(receiver, sender, values)
 *
 * The argument order of the link paramset was checked on a real CCU (HmIP-RF):
 * `getParamset(receiver, sender)` returns the `SHORT_*` / `LONG_*` parameters,
 * `getParamset(sender, receiver)` an empty struct.
 *
 * Catalogue source: eq-3/occu
 * `WebUI/www/config/easymodes/SWITCH_VIRTUAL_RECEIVER/KEY_TRANSCEIVER.tcl` —
 * the WebUI's easy-mode profiles for a `KEY_TRANSCEIVER` sender linked to a
 * HmIP `SWITCH_VIRTUAL_RECEIVER`: `PROFILE_1` switch on, `PROFILE_2` switch
 * off, `PROFILE_3` switch on/off (toggle). Each value below is the FIRST entry
 * of that file's list, i.e. the value the WebUI writes; enum indices are the
 * CCU's own `VALUE_LIST` order (`getParamsetDescription(receiver, "LINK")`):
 * jump targets `NOP 0, ON_DELAY 1, RAMP_ON 2, ON 3, OFF_DELAY 4, RAMP_OFF 5,
 * OFF 6`; `PROFILE_ACTION_TYPE` `INACTIVE 0, JUMP 1, TOGGLE 2`.
 *
 * `none` is `<PREFIX>_PROFILE_ACTION_TYPE = 0` (`PROFILE_ACTION_TYPE_INACTIVE`)
 * and nothing else. For the long press this is what the WebUI writes when the
 * long key press is switched off (`getDeactivateLongKeypress`, eq-3/occu
 * `WebUI/www/config/easymodes/etc/uiElements.tcl`, `optionDisable 0`). No
 * easy-mode deactivates the SHORT press; short `none` uses the same
 * `PROFILE_ACTION_TYPE_INACTIVE` value from the CCU's `VALUE_LIST`.
 *
 * Matching is EXACT: a press half is a catalogue action only when every
 * parameter equals the value that action writes. The WebUI's matcher
 * (`get_cur_profile2`, eq-3/occu `WebUI/www/config/ic_common.tcl`) also accepts
 * alternatives (`{1 3 5}`, any time in a `range`); those read `custom` here, so
 * a timer or an alternative jump table is never silently overwritten — and the
 * exact match keeps the three actions disjoint (with the alternatives, the long
 * half of the CCU's default toggle link would also match `off`).
 */

import type { XmlRpcValue } from '../transport/xmlrpc/types.js';
import type {
  HmLinkPressAction,
  HmLinkProfile,
  HmSwitchLinkActions,
} from './types.js';

/** `getLinks` row narrowed to what the facade exposes, before profile resolution. */
export interface ParsedLink {
  readonly sender: string;
  readonly receiver: string;
  readonly name: string;
  readonly description: string;
}

/** Sender channel type the catalogue covers (file name in the easymode dir). */
export const SWITCH_LINK_SENDER_TYPE = 'KEY_TRANSCEIVER';
/** Receiver channel type the catalogue covers (the easymode dir name). */
export const SWITCH_LINK_RECEIVER_TYPE = 'SWITCH_VIRTUAL_RECEIVER';

type LinkParamValue = number | boolean;
type HalfValues = Readonly<Record<string, LinkParamValue>>;
type PressPrefix = 'SHORT' | 'LONG';
type ActiveAction = Exclude<HmLinkPressAction, 'none'>;

const ACTION_TYPE = 'PROFILE_ACTION_TYPE';
const ACTION_TYPE_INACTIVE = 0;
const ACTION_TYPE_JUMP = 1;

/**
 * Parameters every KEY_TRANSCEIVER.tcl profile writes with the same value
 * (first list entry): conditions, condition thresholds, delays 0, on/off time
 * `BASE_1_H` (7) × 31 (the "permanent" choice), absolute time mode, JUMP.
 */
const COMMON: HalfValues = {
  COND_VALUE_HI: 150,
  COND_VALUE_LO: 50,
  CT_OFF: 0,
  CT_OFFDELAY: 0,
  CT_ON: 0,
  CT_ONDELAY: 0,
  OFFDELAY_TIME_BASE: 0,
  OFFDELAY_TIME_FACTOR: 0,
  OFF_TIME_BASE: 7,
  OFF_TIME_FACTOR: 31,
  OFF_TIME_MODE: 0,
  ONDELAY_TIME_BASE: 0,
  ONDELAY_TIME_FACTOR: 0,
  ON_TIME_BASE: 7,
  ON_TIME_FACTOR: 31,
  ON_TIME_MODE: 0,
  MULTIEXECUTE: false,
  [ACTION_TYPE]: ACTION_TYPE_JUMP,
};

/**
 * Per action, per press: the jump table. Short and long are listed apart
 * because KEY_TRANSCEIVER.tcl lists them apart; the written (first) values
 * happen to coincide.
 *
 * - on     PROFILE_1: JT_OFF {1 3 5}, JT_OFFDELAY {3 5}, JT_ON {1 3}, JT_ONDELAY {3 1}
 * - off    PROFILE_2: SHORT JT_OFF 6, JT_OFFDELAY 6, JT_ON {4 6}, JT_ONDELAY 6;
 *                     LONG  JT_OFF {6 1}, JT_OFFDELAY 6, JT_ON {4 6}, JT_ONDELAY {6 3}
 * - toggle PROFILE_3: JT_OFF {1 3}, JT_OFFDELAY {6 5}, JT_ON {4 6}, JT_ONDELAY {3 2}
 */
const JUMP_TABLES: Readonly<Record<ActiveAction, Readonly<Record<PressPrefix, HalfValues>>>> = {
  on: {
    SHORT: { JT_OFF: 1, JT_OFFDELAY: 3, JT_ON: 1, JT_ONDELAY: 3 },
    LONG: { JT_OFF: 1, JT_OFFDELAY: 3, JT_ON: 1, JT_ONDELAY: 3 },
  },
  off: {
    SHORT: { JT_OFF: 6, JT_OFFDELAY: 6, JT_ON: 4, JT_ONDELAY: 6 },
    LONG: { JT_OFF: 6, JT_OFFDELAY: 6, JT_ON: 4, JT_ONDELAY: 6 },
  },
  toggle: {
    SHORT: { JT_OFF: 1, JT_OFFDELAY: 6, JT_ON: 4, JT_ONDELAY: 3 },
    LONG: { JT_OFF: 1, JT_OFFDELAY: 6, JT_ON: 4, JT_ONDELAY: 3 },
  },
};

/** Checked in this order; the exact values make them disjoint. */
const ACTIVE_ACTIONS: readonly ActiveAction[] = ['toggle', 'on', 'off'];

function halfValues(prefix: PressPrefix, action: HmLinkPressAction): Record<string, LinkParamValue> {
  if (action === 'none') return { [`${prefix}_${ACTION_TYPE}`]: ACTION_TYPE_INACTIVE };
  const out: Record<string, LinkParamValue> = {};
  for (const [param, value] of Object.entries({ ...COMMON, ...JUMP_TABLES[action][prefix] })) {
    out[`${prefix}_${param}`] = value;
  }
  return out;
}

/**
 * The exact `putParamset(receiver, sender, …)` values for a short + long
 * action pair: the full KEY_TRANSCEIVER.tcl half for an active action, only
 * `PROFILE_ACTION_TYPE = 0` for `none`.
 */
export function switchLinkValues(actions: HmSwitchLinkActions): Record<string, LinkParamValue> {
  return { ...halfValues('SHORT', actions.short), ...halfValues('LONG', actions.long) };
}

/** XML-RPC booleans and 0/1 integers compare equal; anything else must be identical. */
function sameValue(actual: unknown, expected: LinkParamValue): boolean {
  const normalised = typeof actual === 'boolean' ? (actual ? 1 : 0) : actual;
  const want = typeof expected === 'boolean' ? (expected ? 1 : 0) : expected;
  return normalised === want;
}

function classifyHalf(
  paramset: Readonly<Record<string, unknown>>,
  prefix: PressPrefix,
): HmLinkPressAction | undefined {
  const actionType = paramset[`${prefix}_${ACTION_TYPE}`];
  if (actionType === undefined) return undefined;
  if (sameValue(actionType, ACTION_TYPE_INACTIVE)) return 'none';
  return ACTIVE_ACTIONS.find((action) =>
    Object.entries(halfValues(prefix, action)).every(([param, value]) =>
      sameValue(paramset[param], value),
    ),
  );
}

/** Classify a receiver link paramset into the switch catalogue, or `custom`. */
export function classifyLinkParamset(paramset: Readonly<Record<string, unknown>>): HmLinkProfile {
  const short = classifyHalf(paramset, 'SHORT');
  const long = classifyHalf(paramset, 'LONG');
  if (short === undefined || long === undefined) return { kind: 'custom' };
  return { kind: 'switch', short, long };
}

/** True when the catalogue applies to a sender / receiver channel type pair. */
export function isSwitchLinkPair(
  senderType: string | undefined,
  receiverType: string | undefined,
): boolean {
  return senderType === SWITCH_LINK_SENDER_TYPE && receiverType === SWITCH_LINK_RECEIVER_TYPE;
}

function isStruct(value: XmlRpcValue): value is { [key: string]: XmlRpcValue } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}

function nonEmptyString(value: XmlRpcValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Narrow a `getLinks` result. A non-array is no links; an entry without
 * `SENDER` / `RECEIVER` is dropped; a missing `NAME` / `DESCRIPTION` is `""`.
 */
export function parseLinks(value: XmlRpcValue): ParsedLink[] {
  if (!Array.isArray(value)) return [];
  const links: ParsedLink[] = [];
  for (const entry of value) {
    if (!isStruct(entry)) continue;
    const sender = nonEmptyString(entry['SENDER']);
    const receiver = nonEmptyString(entry['RECEIVER']);
    if (sender === undefined || receiver === undefined) continue;
    const name = entry['NAME'];
    const description = entry['DESCRIPTION'];
    links.push({
      sender,
      receiver,
      name: typeof name === 'string' ? name : '',
      description: typeof description === 'string' ? description : '',
    });
  }
  return links;
}
