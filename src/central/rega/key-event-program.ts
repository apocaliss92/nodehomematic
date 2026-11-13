/**
 * ReGa scripts for the CCU program that makes a device send key presses.
 *
 * A HmIP device sends `PRESS_SHORT` / `PRESS_LONG` to the access point only
 * while the CCU USES the key: a program whose condition references the key's
 * data point. A central link (`reportValueUsage`) alone is not enough. The
 * program built here has one rule, one condition (OR) and one single condition
 * per `<interface>.<channel>.<PARAM>` data point, triggered on update, with no
 * destination.
 *
 * Sources for every call below:
 * - eq-3/occu `WebUI/bin/hm_autoconf` (programs built from script):
 *   `dom.CreateObject(OT_PROGRAM)`, `ID_PROGRAMS.Add(id)`, `prg.Rule()`,
 *   `rule.RuleOperatorType(2)`, `rule.RuleAddCondition()`,
 *   `cond.CndOperatorType(2)`, `cond.CndAddSingle()`, `OperatorType(1)`,
 *   `ConditionType2(13)` (the WebUI's DP_VALUE_CHECK_UPDATE, `rega/esp/sico.fn`
 *   `SetConditionType2`), `LeftValType(ivtObjectId)`, `LeftVal(dpId)`,
 *   `ConditionChannel(chId)`, `prg.Internal(..)`, `prg.Active(true)`,
 *   `dom.RTUpdate(0)`.
 * - eq-3/occu `WebUI/www/rega/esp/sico.fn` `SetChannel`: a channel condition is
 *   `LeftValType(ivtObjectId)`, `LeftVal(dp)`, `ConditionChannel(ch)`,
 *   `ConditionType(1)`.
 * - eq-3/occu `WebUI/www/rega/esp/programs.fn`: `DeleteCondition` /
 *   `DeleteSingleCondition` (`RuleDelCondition(condId)`), `RuleCondition(0)`,
 *   `CndSingleCount()`, `CndSingleCondition(i)`, `DeleteProgram`
 *   (`dom.DeleteObject(id)`), `AddCondition` (operator pairing).
 *
 * The scripts are built, not constants, because the data point list varies;
 * every data point name is validated against {@link DATAPOINT_NAME} first, so
 * nothing but `[0-9A-Za-z_:.-]` reaches the script text. The program name goes
 * through the runner's `##name##` placeholder (escaped there).
 */
import { ValidationError } from '../../support/errors.js';

/** `<interface>.<device>:<channel>.<PARAM>`, the ReGa name of a key data point. */
export const DATAPOINT_NAME = /^[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+:\d+\.PRESS_(?:SHORT|LONG)$/;

function checkedDatapoints(datapoints: readonly string[]): readonly string[] {
  if (datapoints.length === 0) {
    throw new ValidationError('A key event program needs at least one data point.');
  }
  for (const name of datapoints) {
    if (!DATAPOINT_NAME.test(name)) {
      throw new ValidationError(`Invalid key data point "${name}".`);
    }
  }
  return datapoints;
}

/** Find the program named `##name##` into `oProg` (null when absent). */
const FIND_PROGRAM = `string sName = "##name##";
object oPrograms = dom.GetObject(ID_PROGRAMS);
object oProg;
string sPid;
foreach(sPid, oPrograms.EnumUsedIDs()) {
    object oCand = dom.GetObject(sPid);
    if (oCand) {
        if (oCand.Name() == sName) {
            oProg = oCand;
        }
    }
}`;

/**
 * Create or rewrite the program `##name##` so its conditions are exactly the
 * given data points. Emits `{"programId":"<id>","created":true|false}`, or
 * `{"error":"datapoint","missing":["<dp>",...]}` (nothing is written then).
 */
export function buildEnsureKeyEventProgram(datapoints: readonly string[]): string {
  const dps = checkedDatapoints(datapoints);
  const lookups = dps
    .map(
      (dp, i) => `object oDp${i} = dom.GetObject("${dp}");
if (!oDp${i}) {
    sMissing = sMissing # sMissSep # "\\"${dp}\\"";
    sMissSep = ",";
}`,
    )
    .join('\n');
  const singles = dps
    .map(
      (_dp, i) => `oSc = oCnd.CndAddSingle();
oSc.OperatorType(1);
oSc.ConditionType(1);
oSc.ConditionType2(13);
oSc.LeftValType(ivtObjectId);
oSc.LeftVal(oDp${i}.ID());
oSc.ConditionChannel(oDp${i}.Channel());`,
    )
    .join('\n');
  return `! nodehomematic:ensureKeyEventProgram
${FIND_PROGRAM}
string sMissing = "";
string sMissSep = "";
${lookups}
if (sMissing != "") {
    Write("{\\"error\\":\\"datapoint\\",\\"missing\\":[" # sMissing # "]}");
} else {
    boolean bCreated = false;
    if (!oProg) {
        oProg = dom.CreateObject(OT_PROGRAM);
        oProg.Name(sName);
        oPrograms.Add(oProg.ID());
        bCreated = true;
    }
    object oRule = oProg.Rule();
    oRule.RuleOperatorType(2);
    integer iCnt = oRule.RuleConditions().Count();
    while (iCnt > 0) {
        object oOld = oRule.RuleCondition(0);
        oRule.RuleDelCondition(oOld.ID());
        iCnt = iCnt - 1;
    }
    object oCnd = oRule.RuleAddCondition();
    oCnd.CndOperatorType(2);
    object oSc;
${singles}
    oProg.Internal(false);
    oProg.Active(true);
    dom.RTUpdate(0);
    Write("{\\"programId\\":\\"");
    Write(oProg.ID());
    Write("\\",\\"created\\":");
    if (bCreated) {
        Write("true");
    } else {
        Write("false");
    }
    Write("}");
}`;
}

/**
 * Delete the program `##name##`. Emits `{"removed":true|false}`; `false` when
 * no such program exists. `dom.DeleteObject` is the WebUI's own delete
 * (`programs.fn` `DeleteProgram`).
 */
export const REMOVE_KEY_EVENT_PROGRAM = `! nodehomematic:removeKeyEventProgram
${FIND_PROGRAM}
if (oProg) {
    dom.DeleteObject(oProg.ID());
    Write("{\\"removed\\":true}");
} else {
    Write("{\\"removed\\":false}");
}`;

/**
 * Read the program `##name##`: `{"found":false}` or
 * `{"found":true,"programId":"<id>","datapoints":["<dp name>",...]}` from the
 * first condition's single conditions (`LeftVal` data point names).
 */
export const GET_KEY_EVENT_PROGRAM = `! nodehomematic:getKeyEventProgram
${FIND_PROGRAM}
if (!oProg) {
    Write("{\\"found\\":false}");
} else {
    Write("{\\"found\\":true,\\"programId\\":\\"");
    Write(oProg.ID());
    Write("\\",\\"datapoints\\":[");
    object oCnd = oProg.Rule().RuleCondition(0);
    if (oCnd) {
        integer iN = oCnd.CndSingleCount();
        integer iI = 0;
        string sSep = "";
        while (iI < iN) {
            object oSc = oCnd.CndSingleCondition(iI);
            object oDp = dom.GetObject(oSc.LeftVal());
            if (oDp) {
                Write(sSep);
                Write("\\"");
                Write(oDp.Name());
                Write("\\"");
                sSep = ",";
            }
            iI = iI + 1;
        }
    }
    Write("]}");
}`;
