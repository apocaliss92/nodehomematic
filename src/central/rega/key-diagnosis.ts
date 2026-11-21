/**
 * ReGa script that reads (never writes) what the CCU knows about a device's
 * key channels, to answer "does the CCU itself register the key press?".
 *
 * For every given key channel it reads the channel object and its
 * `PRESS_SHORT` / `PRESS_LONG` / `PRESS_LONG_RELEASE` data points, and it lists
 * every program whose condition references one of those data points.
 *
 * Sources for every call below (eq-3/occu, `WebUI`):
 * - Channel lookup by address: enumerate `ID_CHANNELS` (`EnumUsedIDs()`) and
 *   compare `Address()` (the same idiom as `getregaidbyaddress.tcl`, used by
 *   `RENAME_DEVICE` in `scripts.ts`). `ID()`, `Name()`.
 * - Channel flags: `Visible()` (`www/rega/esp/channels.fn` `setVisible`),
 *   `ReadyConfig()` (`channels.fn` `setReadyConfig`: `chn.ReadyConfig()`),
 *   (`Enabled()` is NOT read: occu only ever sets it, and one unknown method
 *   aborts the whole ReGa script; the field is always `null`),
 *   `LastDPActionTimeSeconds()` (`www/rega/esp/system.fn`, the "last action"
 *   dialog: `obj.LastDPActionTime()` / `LastDPActionTimeSeconds()` for an
 *   `OT_CHANNEL`).
 * - Data point by name `<interface>.<address>.<PARAM>`: `dom.GetObject(name)`;
 *   `Value()`; `Timestamp()` / `TimestampSeconds()` (`system.fn`, same dialog
 *   for an `OT_DP`: the time of the last update, even when the value did not
 *   change). `LastTimestamp()` is NOT read: occu only tests it for truth and
 *   no source converts it to a time; `lastTimestamp` is always `null`.
 * - Programs: `EnumUsedIDs()` of `ID_PROGRAMS`, `Active()` (`system.fn`
 *   `objProg.Active()`), `ProgramLastExecuteTime()` /
 *   `ProgramLastExecuteTimeSeconds()` (`system.fn`, the "last action" dialog
 *   for an `OT_PROGRAM`). `Internal()` is NOT read on a program (occu never
 *   reads it there); `internal` is always `null`.
 * - Conditions: `Rule()`, `RuleConditions().Count()`, `RuleCondition(i)`,
 *   `CndSingleCount()`, `CndSingleCondition(i)`, `LeftVal()` (`programs.fn`
 *   and the read script in `key-event-program.ts`). Only single conditions of
 *   a rule's conditions are scanned; a program whose reference sits in a
 *   deeper structure is not listed.
 *
 * Every value is written as a quoted string (a ReGa boolean concatenated with
 * `#` is `true` / `false`, as `system.fn` writes `objProg.Active()` into text)
 * and a name goes through `UriEncode()`, decoded by `decodeRegaName`. The
 * script is built, not constant, because the channel list varies; addresses
 * and the interface name are validated before they reach the script text.
 */
import { ValidationError } from '../../support/errors.js';

const CHANNEL_ADDRESS = /^([0-9A-Za-z_-]+):\d+$/;
const INTERFACE_NAME = /^[0-9A-Za-z_-]+$/;

/** The key parameters whose ReGa data points are read. */
export const KEY_DIAGNOSIS_PARAMETERS: readonly string[] = [
  'PRESS_SHORT',
  'PRESS_LONG',
  'PRESS_LONG_RELEASE',
];

/** The ReGa name of a key data point. */
export function keyDatapointName(
  interfaceName: string,
  channelAddress: string,
  parameter: string,
): string {
  return `${interfaceName}.${channelAddress}.${parameter}`;
}

/**
 * The scan of `ID_PROGRAMS` against `sTargets` (a `|`-delimited name list the
 * caller declared): writes one `{"id","name","active",...,"datapoints":[...]}`
 * object per program whose single conditions reference a target. Shared by the
 * per-device diagnosis and the cluster-wide key program read.
 */
const PROGRAM_SCAN = `string sPrgId;
string sPSep = "";
foreach(sPrgId, dom.GetObject(ID_PROGRAMS).EnumUsedIDs()) {
    object oPrg = dom.GetObject(sPrgId);
    if (oPrg) {
        string sRefs = "";
        string sRSep = "";
        object oRule = oPrg.Rule();
        if (oRule) {
            integer iC = 0;
            integer iCn = oRule.RuleConditions().Count();
            while (iC < iCn) {
                object oCnd = oRule.RuleCondition(iC);
                if (oCnd) {
                    integer iN = oCnd.CndSingleCount();
                    integer iI = 0;
                    while (iI < iN) {
                        object oSc = oCnd.CndSingleCondition(iI);
                        object oLeft = dom.GetObject(oSc.LeftVal());
                        if (oLeft) {
                            string sLn = oLeft.Name();
                            if (sTargets.Find("|" # sLn # "|") != -1) {
                                sRefs = sRefs # sRSep # "\\"" # sLn # "\\"";
                                sRSep = ",";
                            }
                        }
                        iI = iI + 1;
                    }
                }
                iC = iC + 1;
            }
        }
        if (sRefs != "") {
            Write(sPSep);
            sPSep = ",";
            Write("{\\"id\\":\\"" # oPrg.ID() # "\\",\\"name\\":\\"" # oPrg.Name().UriEncode() # "\\",\\"active\\":\\"" # oPrg.Active() # "\\",\\"internal\\":\\"" # "" # "\\",\\"lastExecuteSeconds\\":\\"" # oPrg.ProgramLastExecuteTimeSeconds() # "\\",\\"datapoints\\":[" # sRefs # "]}");
        }
    }
}
`;

function checkedInput(
  interfaceName: string,
  channelAddresses: readonly string[],
): readonly string[] {
  if (!INTERFACE_NAME.test(interfaceName)) {
    throw new ValidationError(`Invalid interface name "${interfaceName}".`);
  }
  for (const address of channelAddresses) {
    if (!CHANNEL_ADDRESS.test(address)) {
      throw new ValidationError(`Invalid channel address "${address}".`);
    }
  }
  return channelAddresses;
}

function channelBlock(interfaceName: string, address: string, i: number): string {
  const dps = KEY_DIAGNOSIS_PARAMETERS.map((parameter) => {
    const name = keyDatapointName(interfaceName, address, parameter);
    return `oDp = dom.GetObject("${name}");
Write(sDpSep);
sDpSep = ",";
Write("{\\"name\\":\\"${name}\\"");
if (oDp) {
    Write(",\\"exists\\":true,\\"id\\":\\"" # oDp.ID() # "\\",\\"value\\":\\"" # ("" # oDp.Value()).UriEncode() # "\\",\\"timestampSeconds\\":\\"" # oDp.TimestampSeconds() # "\\",\\"lastTimestampSeconds\\":\\"" # "" # "\\"}");
} else {
    Write(",\\"exists\\":false}");
}`;
  }).join('\n');
  return `Write(sSep);
sSep = ",";
Write("{\\"address\\":\\"${address}\\",");
if (sChId${i} == "") {
    Write("\\"found\\":false,");
} else {
    object oChn${i} = dom.GetObject(sChId${i});
    Write("\\"found\\":true,\\"id\\":\\"" # oChn${i}.ID() # "\\",\\"name\\":\\"" # oChn${i}.Name().UriEncode() # "\\",\\"visible\\":\\"" # oChn${i}.Visible() # "\\",\\"enabled\\":\\"" # "" # "\\",\\"readyConfig\\":\\"" # oChn${i}.ReadyConfig() # "\\",\\"lastActionSeconds\\":\\"" # oChn${i}.LastDPActionTimeSeconds() # "\\",");
}
Write("\\"datapoints\\":[");
sDpSep = "";
${dps}
Write("]}");`;
}

/**
 * Read the key channels `channelAddresses` (all on `interfaceName`) and the
 * programs that reference their key data points. Emits
 * `{"channels":[{"address","found","id","name":<enc>,"visible","enabled",
 * "readyConfig","lastActionSeconds","datapoints":[{"name","exists","id",
 * "value":<enc>,"timestampSeconds","lastTimestampSeconds"}]}],
 * "programs":[{"id","name":<enc>,"active","internal","lastExecuteSeconds",
 * "datapoints":["<dp name>"]}]}`; every value but `exists` / `found` is a string.
 */
export function buildDiagnoseKeyEvents(
  interfaceName: string,
  channelAddresses: readonly string[],
): string {
  const addresses = checkedInput(interfaceName, channelAddresses);
  const lookups = addresses.map((_a, i) => `string sChId${i} = "";`).join('\n');
  const matches = addresses
    .map(
      (address, i) => `if (oTmp.Address() == "${address}") {
            sChId${i} = sId;
        }`,
    )
    .join('\n        ');
  const targets = addresses
    .flatMap((address) =>
      KEY_DIAGNOSIS_PARAMETERS.map(
        (parameter) =>
          `sTargets = sTargets # "${keyDatapointName(interfaceName, address, parameter)}|";`,
      ),
    )
    .join('\n');
  const blocks = addresses.map((address, i) => channelBlock(interfaceName, address, i)).join('\n');
  return `! nodehomematic:diagnoseKeyEvents
string sId;
string sSep = "";
string sDpSep = "";
string sTargets = "|";
object oDp;
${lookups}
${targets}
foreach(sId, dom.GetObject(ID_CHANNELS).EnumUsedIDs()) {
    object oTmp = dom.GetObject(sId);
    if (oTmp) {
        ${matches}
    }
}
Write("{\\"channels\\":[");
${blocks}
Write("],\\"programs\\":[");
${PROGRAM_SCAN}
Write("]}");`;
}

/** Key data points per script run; keeps `sTargets` and the script bounded. */
export const KEY_PROGRAM_CHUNK = 100;

/**
 * Read which programs reference the key data points of `channels` (each
 * `{ interfaceName, address }`), in one scan of `ID_PROGRAMS`. Emits
 * `{"programs":[{"id","name":<enc>,"active","internal","lastExecuteSeconds",
 * "datapoints":["<dp name>"]}]}`.
 */
export function buildKeyProgramReferences(
  channels: readonly { readonly interfaceName: string; readonly address: string }[],
): string {
  const targets = channels
    .flatMap((channel) => {
      checkedInput(channel.interfaceName, [channel.address]);
      return KEY_DIAGNOSIS_PARAMETERS.map(
        (parameter) =>
          `sTargets = sTargets # "${keyDatapointName(channel.interfaceName, channel.address, parameter)}|";`,
      );
    })
    .join('\n');
  return `! nodehomematic:keyProgramReferences
string sTargets = "|";
${targets}
Write("{\\"programs\\":[");
${PROGRAM_SCAN}
Write("]}");`;
}
