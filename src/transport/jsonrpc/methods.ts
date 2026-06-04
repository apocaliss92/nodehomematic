/**
 * JSON-RPC method names and param keys used against the CCU WebUI
 * (`/api/homematic.cgi`), mirroring the authoritative names from aiohomematic.
 */

/** The param key under which the session id is injected into requests. */
export const SESSION_ID_PARAM = '_session_id_' as const;

/** Exact JSON-RPC method names accepted by the CCU WebUI. */
export const JsonRpcMethod = {
  CCU_GET_AUTH_ENABLED: 'CCU.getAuthEnabled',
  CCU_GET_HTTPS_REDIRECT_ENABLED: 'CCU.getHttpsRedirectEnabled',
  DEVICE_LIST_ALL_DETAIL: 'Device.listAllDetail',
  DEVICE_SET_NAME: 'Device.setName',
  CHANNEL_SET_NAME: 'Channel.setName',
  INTERFACE_LIST_INTERFACES: 'Interface.listInterfaces',
  INTERFACE_LIST_DEVICES: 'Interface.listDevices',
  INTERFACE_GET_INSTALL_MODE: 'Interface.getInstallMode',
  INTERFACE_SET_INSTALL_MODE_HMIP: 'Interface.setInstallModeHMIP',
  PROGRAM_GET_ALL: 'Program.getAll',
  PROGRAM_EXECUTE: 'Program.execute',
  SYSVAR_GET_ALL: 'SysVar.getAll',
  SYSVAR_GET_VALUE_BY_NAME: 'SysVar.getValueByName',
  SYSVAR_SET_BOOL: 'SysVar.setBool',
  SYSVAR_SET_FLOAT: 'SysVar.setFloat',
  ROOM_GET_ALL: 'Room.getAll',
  SUBSECTION_GET_ALL: 'Subsection.getAll',
  REGA_RUN_SCRIPT: 'ReGa.runScript',
  SESSION_LOGIN: 'Session.login',
  SESSION_LOGOUT: 'Session.logout',
  SESSION_RENEW: 'Session.renew',
  SYSTEM_LIST_METHODS: 'system.listMethods',
} as const;

/** Union of all exact JSON-RPC method name string literals. */
export type JsonRpcMethodName = (typeof JsonRpcMethod)[keyof typeof JsonRpcMethod];

/**
 * The three `Session.*` methods that bypass the circuit breaker (they must be
 * usable even while the breaker is OPEN to recover a session).
 */
export const SESSION_BYPASS_METHODS: ReadonlySet<string> = new Set<string>([
  JsonRpcMethod.SESSION_LOGIN,
  JsonRpcMethod.SESSION_LOGOUT,
  JsonRpcMethod.SESSION_RENEW,
]);
