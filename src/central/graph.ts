/**
 * Immutable device graph model.
 *
 * The graph is raw, typed protocol data — NOT domain model (that is a later
 * phase). A {@link DeviceNode} carries its channels; each {@link ChannelNode}
 * carries the typed {@link ParameterSpec}s derived from the raw paramset
 * descriptions. All shapes are deeply readonly so consumers cannot mutate the
 * graph in place.
 */

import {
  ParameterType,
  isReadable,
  isWritable,
  hasEvents,
  isVisible,
} from '../support/constants.js';
import type { DeviceDescription, ParameterData } from '../transport/xmlrpc/types.js';

/**
 * A typed view of a single parameter, derived from raw {@link ParameterData}.
 * `operations`/`flags` are the raw bitmasks; the booleans are their decoded
 * gating, computed via the shared constant helpers.
 */
export interface ParameterSpec {
  readonly type: ParameterType;
  readonly operations: number;
  readonly flags: number;
  readonly min?: number;
  readonly max?: number;
  readonly default?: unknown;
  readonly unit?: string;
  readonly valueList?: readonly string[];
  readonly special?: unknown;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly hasEvents: boolean;
  readonly visible: boolean;
}

/** Coerce a raw `TYPE` string to a {@link ParameterType}, defaulting to EMPTY. */
function toParameterType(raw: string): ParameterType {
  return (Object.values(ParameterType) as string[]).includes(raw)
    ? (raw as ParameterType)
    : ParameterType.EMPTY;
}

/** Build a {@link ParameterSpec} from raw {@link ParameterData}. */
export function parameterSpecFromData(data: ParameterData): ParameterSpec {
  const operations = data.OPERATIONS ?? 0;
  const flags = data.FLAGS ?? 0;
  const spec: ParameterSpec = {
    type: toParameterType(data.TYPE),
    operations,
    flags,
    readable: isReadable(operations),
    writable: isWritable(operations),
    hasEvents: hasEvents(operations),
    visible: isVisible(flags),
    // Optional fields are only present when supplied (exactOptionalPropertyTypes).
    // min/max are narrowed to a number at construction; non-numeric CCU values
    // (the type allows any XmlRpcValue) are dropped so the spec type holds.
    ...(typeof data.MIN === 'number' ? { min: data.MIN } : {}),
    ...(typeof data.MAX === 'number' ? { max: data.MAX } : {}),
    ...(data.DEFAULT !== undefined ? { default: data.DEFAULT } : {}),
    ...(data.UNIT !== undefined ? { unit: data.UNIT } : {}),
    ...(data.VALUE_LIST !== undefined ? { valueList: data.VALUE_LIST } : {}),
    ...(data.SPECIAL !== undefined ? { special: data.SPECIAL } : {}),
  };
  return spec;
}

/** The typed specs for one parameter across its paramsets. */
export interface ParameterSpecs {
  readonly VALUES?: ParameterSpec;
  readonly MASTER?: ParameterSpec;
}

/** A channel of a device, with its parameters keyed by parameter name. */
export interface ChannelNode {
  readonly address: string;
  readonly index: number;
  readonly type?: string;
  readonly direction?: number;
  readonly parameters: ReadonlyMap<string, ParameterSpecs>;
}

/** A device, carrying its channels plus the merged JSON-RPC metadata. */
export interface DeviceNode {
  readonly address: string;
  readonly type: string;
  readonly interfaceId: string;
  readonly firmware?: string;
  readonly name?: string;
  readonly rooms?: readonly string[];
  readonly functions?: readonly string[];
  readonly channels: readonly ChannelNode[];
  readonly raw: DeviceDescription;
}
