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
