/**
 * HomeMatic-Script (ReGa) bodies executed via `ReGa.runScript`.
 *
 * The four set/describe scripts are taken verbatim from aiohomematic's bundled
 * `.fn` scripts (authoritative against real CCU firmware). {@link GET_ROOMS_FUNCTIONS}
 * is a custom, channel-address-keyed script written against the same ReGa idioms
 * (`get_service_messages.fn`) to recover the rooms/functions mapping that the
 * JSON-RPC API does not expose by channel address.
 *
 * Placeholders use the `##key##` convention substituted by the ReGa runner.
 */

/** Set a string system variable by name. Placeholders: `##name##`, `##value##`. */
export const SET_SYSTEM_VARIABLE = `object sv = dom.GetObject("##name##");
if (sv) {
    sv.State("##value##");
}`;

/** Enable/disable a program. Placeholders: `##id##`, `##state##` (1 active, 0 inactive). */
export const SET_PROGRAM_STATE = `object prog = dom.GetObject(##id##);
if (prog) {
    prog.Active(##state##);
}`;

/**
 * Emit `[{"id":..,"description":<UriEncoded>},...]` for every system variable.
 * Description carries the `HAHM` marker for extended (writable) sysvars.
 */
export const SYSVAR_DESCRIPTIONS = `string sSysVarId;
string sSep = "";
WriteLine("[");
foreach(sSysVarId, dom.GetObject(ID_SYSTEM_VARIABLES).EnumUsedIDs()) {
    object oSysVar = dom.GetObject(sSysVarId);
    Write(sSep);
    Write("{");
    Write("\\"id\\":");
    Write(oSysVar.ID());
    Write(",\\"description\\":\\"");
    Write(oSysVar.DPInfo().UriEncode());
    Write("\\"}");
    sSep = ",";
}
WriteLine("]");`;

/**
 * Emit `[{"id":..,"description":<UriEncoded>},...]` for every program, using
 * `PrgInfo()` as the description source.
 */
export const PROGRAM_DESCRIPTIONS = `string sPrgId;
string sSep = "";
WriteLine("[");
foreach(sPrgId, dom.GetObject(ID_PROGRAMS).EnumUsedIDs()) {
    object oPrg = dom.GetObject(sPrgId);
    Write(sSep);
    Write("{");
    Write("\\"id\\":");
    Write(oPrg.ID());
    Write(",\\"description\\":\\"");
    Write(oPrg.PrgInfo().UriEncode());
    Write("\\"}");
    sSep = ",";
}
WriteLine("]");`;

/**
 * CUSTOM script: build a single JSON object keyed by **channel address**:
 *
 *   {"rooms":{"<addr>":["<encName>",...]},"functions":{"<addr>":["<encName>",...]}}
 *
 * We enumerate every channel (`ID_CHANNELS`), read its `Address()`, then iterate
 * its `ChnRoom()` and `ChnFunction()` id lists, emitting each referenced object's
 * `Name().UriEncode()`. Comma handling is done with per-list / per-channel
 * separator variables so the output is valid JSON. Names are UriEncoded (latin1)
 * and decoded host-side by {@link decodeRegaName}.
 */
export const GET_ROOMS_FUNCTIONS = `string sChnId;
string sRoomId;
string sFuncId;
string sChnSepR = "";
string sChnSepF = "";
Write("{\\"rooms\\":{");
foreach(sChnId, dom.GetObject(ID_CHANNELS).EnumUsedIDs()) {
    object oChn = dom.GetObject(sChnId);
    if (oChn) {
        string sAddr = oChn.Address();
        object oRooms = oChn.ChnRoom();
        if (oRooms && oRooms.Count() > 0) {
            Write(sChnSepR);
            Write("\\"");
            Write(sAddr);
            Write("\\":[");
            string sRoomSep = "";
            foreach(sRoomId, oRooms) {
                object oRoom = dom.GetObject(sRoomId);
                Write(sRoomSep);
                Write("\\"");
                Write(oRoom.Name().UriEncode());
                Write("\\"");
                sRoomSep = ",";
            }
            Write("]");
            sChnSepR = ",";
        }
    }
}
Write("},\\"functions\\":{");
foreach(sChnId, dom.GetObject(ID_CHANNELS).EnumUsedIDs()) {
    object oChn = dom.GetObject(sChnId);
    if (oChn) {
        string sAddr = oChn.Address();
        object oFuncs = oChn.ChnFunction();
        if (oFuncs && oFuncs.Count() > 0) {
            Write(sChnSepF);
            Write("\\"");
            Write(sAddr);
            Write("\\":[");
            string sFuncSep = "";
            foreach(sFuncId, oFuncs) {
                object oFunc = dom.GetObject(sFuncId);
                Write(sFuncSep);
                Write("\\"");
                Write(oFunc.Name().UriEncode());
                Write("\\"");
                sFuncSep = ",";
            }
            Write("]");
            sChnSepF = ",";
        }
    }
}
Write("}}");`;

/**
 * Emit `[{"id","name"(UriEncoded),"address"("DEV:ch"),"type"(HSSID),"timestamp"
 * (epoch seconds),"acknowledgeable"},...]` for every ACTIVE service message.
 *
 * Source: the WebUI's own listing in eq-3/occu `WebUI/www/rega/esp/system.fn`
 * (`dom.GetObject(ID_SERVICES)`, `OT_ALARMDP`, `AlState() == asOncoming`,
 * `LastTriggerID()` for the message type and channel). A message is
 * acknowledgeable under the same rule the WebUI's `ReceiptAlarm` applies
 * (`WebUI/www/rega/esp/functions.fn`): there is no trigger data point, or the
 * trigger is writable (`STICKY_UNREACH` is; `UNREACH` / `LOWBAT` clear on their own).
 */
export const GET_SERVICE_MESSAGES = `string sAID;
string sSep = "";
Write("[");
foreach(sAID, dom.GetObject(ID_SERVICES).EnumIDs()) {
    object oAlarm = dom.GetObject(sAID);
    if (oAlarm) {
        if (oAlarm.IsTypeOf(OT_ALARMDP)) {
            if (oAlarm.AlState() == asOncoming) {
                string sAddr = "";
                string sType = "";
                string sAck = "true";
                object oLast = dom.GetObject(oAlarm.LastTriggerID());
                if (oLast) {
                    sType = oLast.HSSID();
                    object oChn = dom.GetObject(oLast.Channel());
                    if (oChn) {
                        sAddr = oChn.Address();
                    }
                }
                object oTrig = dom.GetObject(oAlarm.AlTriggerDP());
                if (oTrig) {
                    if (!(oTrig.Operations() & OPERATION_WRITE)) {
                        sAck = "false";
                    }
                }
                Write(sSep);
                Write("{\\"id\\":");
                Write(oAlarm.ID());
                Write(",\\"name\\":\\"");
                Write(oAlarm.Name().UriEncode());
                Write("\\",\\"address\\":\\"");
                Write(sAddr);
                Write("\\",\\"type\\":\\"");
                Write(sType);
                Write("\\",\\"timestamp\\":");
                Write(oAlarm.AlOccurrenceTime().ToInteger());
                Write(",\\"acknowledgeable\\":");
                Write(sAck);
                Write("}");
                sSep = ",";
            }
        }
    }
}
Write("]");`;

/**
 * Acknowledge ("quittieren") one service message by ReGa object id. Mirrors the
 * WebUI's `ReceiptAlarm` (`oAlarm.AlReceipt()`). Placeholder: `##id##` (digits
 * only, validated by the caller). Emits `{"ok":true}` when the object existed.
 */
export const ACKNOWLEDGE_SERVICE_MESSAGE = `object oAlarm = dom.GetObject(##id##);
if (oAlarm) {
    oAlarm.AlReceipt();
    Write("{\\"ok\\":true}");
} else {
    Write("{\\"ok\\":false}");
}`;

/**
 * Emit `{"release":<UriEncoded /VERSION>,"host":<UriEncoded hostname>}`. The
 * `/VERSION` file carries `VERSION=` and `PRODUCT=` (CCU3, RaspberryMatic,
 * OpenCCU); no JSON-RPC method exposes the product (`CCU.getVersion` reads only
 * the `VERSION=` line, see eq-3/occu `WebUI/www/api/methods/ccu/getversion.tcl`).
 */
export const GET_CCU_PLATFORM = `string sRelease;
string sHost;
string sErr;
system.Exec("cat /VERSION", &sRelease, &sErr);
system.Exec("hostname", &sHost, &sErr);
Write("{\\"release\\":\\"");
Write(sRelease.UriEncode());
Write("\\",\\"host\\":\\"");
Write(sHost.UriEncode());
Write("\\"}");`;
