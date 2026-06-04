/**
 * Build the public domain model ({@link ModelDevice}[]) from the raw, typed
 * device graph ({@link DeviceNode}[], Phase 2).
 *
 * For each channel, every parameter that has a VALUES {@link ParameterSpec}
 * which is readable OR event-emitting becomes a live {@link GenericDataPoint}.
 * MASTER-only parameters are config and are handled separately (Task 7), so
 * they never become data points here.
 */

import type { DeviceNode, ChannelNode } from '../central/graph.js';
import { ParamsetKey } from '../support/constants.js';
import { makeDpk } from '../support/dpk.js';
import { GenericDataPoint, type InterfaceFamily } from './data-point.js';
import { ModelChannel } from './channel.js';
import { ModelDevice } from './device.js';

/**
 * Classify an interface id into its family. The heuristic: the id contains
 * `HmIP` (case-insensitive) → `HMIP`, otherwise `HM`.
 */
export function interfaceFamilyOf(interfaceId: string): InterfaceFamily {
  return interfaceId.toLowerCase().includes('hmip') ? 'HMIP' : 'HM';
}

/** Build the {@link ModelChannel}s + {@link GenericDataPoint}s for one channel. */
function buildChannel(
  channel: ChannelNode,
  interfaceId: string,
  family: InterfaceFamily,
): ModelChannel {
  const dataPoints: GenericDataPoint[] = [];
  for (const [parameter, specs] of channel.parameters) {
    const spec = specs.VALUES;
    if (spec === undefined || (!spec.readable && !spec.hasEvents)) {
      continue;
    }
    dataPoints.push(
      new GenericDataPoint({
        dpk: makeDpk(interfaceId, channel.address, ParamsetKey.VALUES, parameter),
        spec,
        interfaceFamily: family,
      }),
    );
  }
  return new ModelChannel({
    address: channel.address,
    index: channel.index,
    ...(channel.type !== undefined ? { type: channel.type } : {}),
    dataPoints,
  });
}

/** Build a single {@link ModelDevice} from a raw {@link DeviceNode}. */
export function buildDevice(node: DeviceNode): ModelDevice {
  const family = interfaceFamilyOf(node.interfaceId);
  const channels = node.channels.map((ch) => buildChannel(ch, node.interfaceId, family));
  return new ModelDevice({
    address: node.address,
    type: node.type,
    interfaceId: node.interfaceId,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.rooms !== undefined ? { rooms: node.rooms } : {}),
    ...(node.functions !== undefined ? { functions: node.functions } : {}),
    channels,
  });
}

/** Build the full model: one {@link ModelDevice} per {@link DeviceNode}. */
export function buildModel(nodes: readonly DeviceNode[]): ModelDevice[] {
  return nodes.map((node) => buildDevice(node));
}
