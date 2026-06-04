/**
 * Pure dispatch logic for the XML-RPC callback methods the CCU invokes on us.
 *
 * Each handler decodes positional arguments (exact CCU arg order), optionally
 * emits a {@link RawCallbackEvent}, and returns the XML-RPC response value.
 * There is NO I/O here: {@link CallbackServer} owns the HTTP and serialization.
 */

import { BaseHomematicError } from '../../support/errors.js';
import type { XmlRpcMethodCall, XmlRpcValue } from '../xmlrpc/types.js';
import type { RawCallbackEvent } from './events.js';

/** JSON-RPC / XML-RPC standard fault code: requested method does not exist. */
export const FAULT_METHOD_NOT_FOUND = -32601;
/** JSON-RPC / XML-RPC standard fault code: internal error while handling a call. */
export const FAULT_INTERNAL_ERROR = -32603;

/** Thrown by {@link dispatch} when no handler matches the method name. */
export class MethodNotFoundError extends BaseHomematicError {}

/** Thrown when a handler receives malformed / missing positional arguments. */
export class InvalidParamsError extends BaseHomematicError {}

/** Context injected into the dispatcher: event sink + device-list provider. */
export interface DispatchContext {
  /** Emit a normalized event (CCU → us notifications). */
  readonly emit: (event: RawCallbackEvent) => void;
  /** Provide the device list for `listDevices(interfaceId)`. */
  readonly listDevices: (interfaceId: string) => readonly XmlRpcValue[];
}

function requireString(params: readonly XmlRpcValue[], index: number, name: string): string {
  const value = params[index];
  if (typeof value !== 'string') {
    throw new InvalidParamsError(`expected string argument "${name}" at position ${index}`);
  }
  return value;
}

function requireNumber(params: readonly XmlRpcValue[], index: number, name: string): number {
  const value = params[index];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new InvalidParamsError(`expected number argument "${name}" at position ${index}`);
  }
  return value;
}

function requireArg(params: readonly XmlRpcValue[], index: number, name: string): XmlRpcValue {
  if (index >= params.length) {
    throw new InvalidParamsError(`missing required argument "${name}" at position ${index}`);
  }
  return params[index] as XmlRpcValue;
}

function requireStringArray(params: readonly XmlRpcValue[], index: number, name: string): string[] {
  const value = requireArg(params, index, name);
  if (!Array.isArray(value)) {
    throw new InvalidParamsError(`expected array argument "${name}" at position ${index}`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string') {
      throw new InvalidParamsError(`expected string at "${name}"[${i}]`);
    }
    return item;
  });
}

function requireStructArray(
  params: readonly XmlRpcValue[],
  index: number,
  name: string,
): Record<string, unknown>[] {
  const value = requireArg(params, index, name);
  if (!Array.isArray(value)) {
    throw new InvalidParamsError(`expected array argument "${name}" at position ${index}`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new InvalidParamsError(`expected struct at "${name}"[${i}]`);
    }
    return item as Record<string, unknown>;
  });
}

type Handler = (call: XmlRpcMethodCall, ctx: DispatchContext) => XmlRpcValue;

const handlers: Readonly<Record<string, Handler>> = {
  event(call, ctx): XmlRpcValue {
    const { params } = call;
    ctx.emit({
      type: 'event',
      interfaceId: requireString(params, 0, 'interfaceId'),
      channelAddress: requireString(params, 1, 'channelAddress'),
      parameter: requireString(params, 2, 'parameter'),
      value: requireArg(params, 3, 'value'),
    });
    return true;
  },

  newDevices(call, ctx): XmlRpcValue {
    const { params } = call;
    ctx.emit({
      type: 'newDevices',
      interfaceId: requireString(params, 0, 'interfaceId'),
      descriptions: requireStructArray(params, 1, 'deviceDescriptions'),
    });
    return true;
  },

  deleteDevices(call, ctx): XmlRpcValue {
    const { params } = call;
    ctx.emit({
      type: 'deleteDevices',
      interfaceId: requireString(params, 0, 'interfaceId'),
      addresses: requireStringArray(params, 1, 'addresses'),
    });
    return true;
  },

  updateDevice(call, ctx): XmlRpcValue {
    const { params } = call;
    ctx.emit({
      type: 'updateDevice',
      interfaceId: requireString(params, 0, 'interfaceId'),
      address: requireString(params, 1, 'address'),
      hint: requireNumber(params, 2, 'hint'),
    });
    return true;
  },

  replaceDevice(call, ctx): XmlRpcValue {
    const { params } = call;
    ctx.emit({
      type: 'replaceDevice',
      interfaceId: requireString(params, 0, 'interfaceId'),
      oldAddress: requireString(params, 1, 'oldAddress'),
      newAddress: requireString(params, 2, 'newAddress'),
    });
    return true;
  },

  readdedDevice(call, ctx): XmlRpcValue {
    const { params } = call;
    ctx.emit({
      type: 'readdedDevice',
      interfaceId: requireString(params, 0, 'interfaceId'),
      addresses: requireStringArray(params, 1, 'addresses'),
    });
    return true;
  },

  error(call, ctx): XmlRpcValue {
    const { params } = call;
    ctx.emit({
      type: 'error',
      interfaceId: requireString(params, 0, 'interfaceId'),
      code: requireNumber(params, 1, 'errorCode'),
      message: requireString(params, 2, 'msg'),
    });
    return true;
  },

  listDevices(call, ctx): XmlRpcValue {
    const interfaceId = requireString(call.params, 0, 'interfaceId');
    return [...ctx.listDevices(interfaceId)];
  },

  'system.listMethods'(): XmlRpcValue {
    return [...SUPPORTED_METHODS];
  },

  'system.methodHelp'(): XmlRpcValue {
    // No per-method help text is required; return an empty string.
    return '';
  },

  'system.multicall'(call, ctx): XmlRpcValue {
    return runMulticall(call.params[0], ctx);
  },
};

/** Method names this server advertises via `system.listMethods`. */
export const SUPPORTED_METHODS: readonly string[] = [
  'event',
  'newDevices',
  'deleteDevices',
  'updateDevice',
  'replaceDevice',
  'readdedDevice',
  'listDevices',
  'error',
  'system.listMethods',
  'system.methodHelp',
  'system.multicall',
];

function faultStruct(code: number, message: string): XmlRpcValue {
  return { faultCode: code, faultString: message };
}

/** Narrow an {@link XmlRpcValue} to a plain struct (rejecting arrays/Date/binary). */
function asStruct(value: XmlRpcValue): { [key: string]: XmlRpcValue } | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date ||
    value instanceof Uint8Array
  ) {
    return undefined;
  }
  return value;
}

/** Execute a `system.multicall` payload, wrapping each result/fault per spec. */
function runMulticall(rawCalls: XmlRpcValue | undefined, ctx: DispatchContext): XmlRpcValue[] {
  if (!Array.isArray(rawCalls)) {
    throw new InvalidParamsError('system.multicall expects an array of calls');
  }
  return rawCalls.map((entry) => {
    const struct = asStruct(entry);
    if (struct === undefined) {
      return faultStruct(FAULT_INTERNAL_ERROR, 'multicall entry is not a struct');
    }
    const methodName = struct['methodName'];
    const params = struct['params'];
    if (typeof methodName !== 'string') {
      return faultStruct(FAULT_INTERNAL_ERROR, 'multicall entry missing methodName');
    }
    if (methodName === 'system.multicall') {
      // Per the XML-RPC multicall convention, recursion is not allowed.
      return faultStruct(FAULT_INTERNAL_ERROR, 'recursive system.multicall is not supported');
    }
    const callParams: XmlRpcValue[] = Array.isArray(params) ? params : [];
    try {
      const result = dispatch({ methodName, params: callParams }, ctx);
      return [result ?? true];
    } catch (err) {
      if (err instanceof MethodNotFoundError) {
        return faultStruct(FAULT_METHOD_NOT_FOUND, errorMessage(err));
      }
      return faultStruct(FAULT_INTERNAL_ERROR, errorMessage(err));
    }
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispatch a parsed XML-RPC method call to its handler.
 *
 * @throws {MethodNotFoundError} when the method name is unknown.
 * @throws {InvalidParamsError} (or any handler error) on malformed arguments.
 */
export function dispatch(call: XmlRpcMethodCall, ctx: DispatchContext): XmlRpcValue {
  const handler = handlers[call.methodName];
  if (handler === undefined) {
    throw new MethodNotFoundError(`unknown callback method: ${call.methodName}`);
  }
  return handler(call, ctx);
}
