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

// --- names and rooms ---------------------------------------------------------
//
// Each script below starts with a `! nodehomematic:<op>` comment line (a ReGa
// comment) naming the operation, and declares its inputs as `string sX =
// "##x##";` lines so the substituted values are plain, escaped string literals.
// Names are written back `UriEncode`d (latin1) and decoded by `decodeRegaName`.

/**
 * Rename a device and, when `##channels##` is `1`, every channel of it to
 * `<name>:<channel number>`. The lookup by address is Device.getReGaIDByAddress
 * (eq-3/occu `WebUI/www/api/methods/device/getregaidbyaddress.tcl`); the write
 * is `Name()` as in `device/setname.tcl` and `channel/setname.tcl`, which also
 * read the name back because the CCU keeps names unique.
 *
 * Emits `{"ok":false}` for an unknown address, else
 * `{"ok":true,"name":<enc>,"channels":[{"address","name":<enc>},...]}`.
 */
export const RENAME_DEVICE = `! nodehomematic:renameDevice
string sAddress = "##address##";
string sName = "##name##";
string sChannels = "##channels##";
string sId;
string sDevId = "";
string sSep = "";
foreach(sId, root.Devices().EnumIDs()) {
    object oTmp = dom.GetObject(sId);
    if (oTmp) {
        if (oTmp.Address() == sAddress) {
            sDevId = sId;
        }
    }
}
if (sDevId == "") {
    Write("{\\"ok\\":false}");
} else {
    object oDev = dom.GetObject(sDevId);
    oDev.Name(sName);
    Write("{\\"ok\\":true,\\"name\\":\\"");
    Write(oDev.Name().UriEncode());
    Write("\\",\\"channels\\":[");
    if (sChannels == "1") {
        foreach(sId, oDev.Channels().EnumUsedIDs()) {
            object oChn = dom.GetObject(sId);
            if (oChn) {
                oChn.Name(sName # ":" # oChn.ChnNumber());
                Write(sSep);
                Write("{\\"address\\":\\"");
                Write(oChn.Address());
                Write("\\",\\"name\\":\\"");
                Write(oChn.Name().UriEncode());
                Write("\\"}");
                sSep = ",";
            }
        }
    }
    Write("]}");
}`;

/**
 * Rename one channel (eq-3/occu `WebUI/www/api/methods/channel/setname.tcl`),
 * found by address among `ID_CHANNELS`. Emits `{"ok":false}` or
 * `{"ok":true,"name":<enc>}`.
 */
export const RENAME_CHANNEL = `! nodehomematic:renameChannel
string sAddress = "##address##";
string sName = "##name##";
string sId;
string sChnId = "";
foreach(sId, dom.GetObject(ID_CHANNELS).EnumUsedIDs()) {
    object oTmp = dom.GetObject(sId);
    if (oTmp) {
        if (oTmp.Address() == sAddress) {
            sChnId = sId;
        }
    }
}
if (sChnId == "") {
    Write("{\\"ok\\":false}");
} else {
    object oChn = dom.GetObject(sChnId);
    oChn.Name(sName);
    Write("{\\"ok\\":true,\\"name\\":\\"");
    Write(oChn.Name().UriEncode());
    Write("\\"}");
}`;

/**
 * Every room with its member channels by ADDRESS:
 * `[{"id":"<id>","name":<enc>,"channels":["DEV:1",...]},...]`. Same walk as
 * Room.getAll (eq-3/occu `WebUI/www/api/methods/room/getall.tcl`:
 * `ID_ROOMS` → `EnumUsedIDs()`), which answers ReGa ids instead of addresses.
 */
export const LIST_ROOMS = `! nodehomematic:listRooms
string sRoomId;
string sChnId;
string sRoomSep = "";
string sChnSep = "";
Write("[");
foreach(sRoomId, dom.GetObject(ID_ROOMS).EnumUsedIDs()) {
    object oRoom = dom.GetObject(sRoomId);
    if (oRoom) {
        Write(sRoomSep);
        Write("{\\"id\\":\\"");
        Write(oRoom.ID());
        Write("\\",\\"name\\":\\"");
        Write(oRoom.Name().UriEncode());
        Write("\\",\\"channels\\":[");
        sChnSep = "";
        foreach(sChnId, oRoom.EnumUsedIDs()) {
            object oChn = dom.GetObject(sChnId);
            if (oChn) {
                if (oChn.IsTypeOf(OT_CHANNEL)) {
                    Write(sChnSep);
                    Write("\\"");
                    Write(oChn.Address());
                    Write("\\"");
                    sChnSep = ",";
                }
            }
        }
        Write("]}");
        sRoomSep = ",";
    }
}
Write("]");`;

/**
 * Create a room: eq-3/occu `WebUI/www/rega/esp/rooms.fn` `::createRoomRetId`
 * (`dom.CreateObject(OT_ENUM, name)`, `EnumType(etRoom)`, add to `ID_ROOMS`,
 * delete the object again when the add fails). A room of the same name is
 * refused first. Emits `{"id":"<id>","name":<enc>}`, `{"error":"exists"}` or
 * `{"error":"failed"}`.
 */
export const CREATE_ROOM = `! nodehomematic:createRoom
string sName = "##name##";
string sId;
boolean bExists = false;
foreach(sId, dom.GetObject(ID_ROOMS).EnumUsedIDs()) {
    object oTmp = dom.GetObject(sId);
    if (oTmp) {
        if (oTmp.Name() == sName) {
            bExists = true;
        }
    }
}
if (bExists) {
    Write("{\\"error\\":\\"exists\\"}");
} else {
    object oRoom = dom.CreateObject(OT_ENUM, sName);
    if (oRoom) {
        oRoom.EnumType(etRoom);
        boolean bAdded = dom.GetObject(ID_ROOMS).Add(oRoom);
        if (bAdded) {
            Write("{\\"id\\":\\"");
            Write(oRoom.ID());
            Write("\\",\\"name\\":\\"");
            Write(oRoom.Name().UriEncode());
            Write("\\"}");
        } else {
            dom.DeleteObject(oRoom.ID());
            Write("{\\"error\\":\\"failed\\"}");
        }
    } else {
        Write("{\\"error\\":\\"failed\\"}");
    }
}`;

/**
 * Rename a room (eq-3/occu `WebUI/www/rega/esp/rooms.fn` `::changeRoomName`),
 * only when `##id##` is a member of `ID_ROOMS`. Emits `{"ok":true|false}`.
 */
export const RENAME_ROOM = `! nodehomematic:renameRoom
string sRoomId = "##id##";
string sName = "##name##";
string sId;
boolean bFound = false;
foreach(sId, dom.GetObject(ID_ROOMS).EnumUsedIDs()) {
    if (sId == sRoomId) {
        bFound = true;
    }
}
if (bFound) {
    object oRoom = dom.GetObject(sRoomId);
    oRoom.Name(sName);
    Write("{\\"ok\\":true}");
} else {
    Write("{\\"ok\\":false}");
}`;

/**
 * Delete a room: the WebUI's generic delete (eq-3/occu
 * `WebUI/www/rega/esp/system.fn` `::DeleteObject`, refused for an
 * `Unerasable()` object), only when `##id##` is a member of `ID_ROOMS`.
 * Emits `{"ok":true}` or `{"ok":false,"reason":"room"|"unerasable"}`.
 */
export const DELETE_ROOM = `! nodehomematic:deleteRoom
string sRoomId = "##id##";
string sId;
boolean bFound = false;
foreach(sId, dom.GetObject(ID_ROOMS).EnumUsedIDs()) {
    if (sId == sRoomId) {
        bFound = true;
    }
}
if (bFound) {
    object oRoom = dom.GetObject(sRoomId);
    if (oRoom.Unerasable()) {
        Write("{\\"ok\\":false,\\"reason\\":\\"unerasable\\"}");
    } else {
        dom.DeleteObject(oRoom.ID());
        Write("{\\"ok\\":true}");
    }
} else {
    Write("{\\"ok\\":false,\\"reason\\":\\"room\\"}");
}`;

/**
 * Add (`##op##` = `add`) or remove (`remove`) a channel, by address, to/from a
 * room: Room.addChannel / Room.removeChannel (eq-3/occu
 * `WebUI/www/api/methods/room/addchannel.tcl`, `removechannel.tcl`:
 * `room.Add(channelId)` / `room.Remove(channelId)`). Emits `{"ok":true}` or
 * `{"ok":false,"reason":"room"|"channel"}`.
 */
export const ROOM_CHANNEL = `! nodehomematic:roomChannel
string sRoomId = "##id##";
string sAddress = "##address##";
string sOp = "##op##";
string sId;
string sChnId = "";
boolean bFound = false;
foreach(sId, dom.GetObject(ID_ROOMS).EnumUsedIDs()) {
    if (sId == sRoomId) {
        bFound = true;
    }
}
foreach(sId, dom.GetObject(ID_CHANNELS).EnumUsedIDs()) {
    object oTmp = dom.GetObject(sId);
    if (oTmp) {
        if (oTmp.Address() == sAddress) {
            sChnId = sId;
        }
    }
}
if (!bFound) {
    Write("{\\"ok\\":false,\\"reason\\":\\"room\\"}");
} else {
    if (sChnId == "") {
        Write("{\\"ok\\":false,\\"reason\\":\\"channel\\"}");
    } else {
        object oRoom = dom.GetObject(sRoomId);
        if (sOp == "add") {
            oRoom.Add(sChnId);
        } else {
            oRoom.Remove(sChnId);
        }
        Write("{\\"ok\\":true}");
    }
}`;
