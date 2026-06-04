import { ModelDevice } from '../../../../src/model/device.js';
import { ModelChannel } from '../../../../src/model/channel.js';
import { GenericDataPoint } from '../../../../src/model/data-point.js';
import type { ParameterSpec } from '../../../../src/central/graph.js';
import { makeDpk } from '../../../../src/support/dpk.js';
import { ParameterType, Operations } from '../../../../src/support/constants.js';
import type { CustomEntityWriter } from '../../../../src/model/custom/base.js';
import type { HmValue } from '../../../../src/model/converter.js';

const RWE = Operations.READ | Operations.WRITE | Operations.EVENT;

export const INTERFACE_ID = 'MyCCU-HmIP-RF';

export function makeSpec(type: ParameterType): ParameterSpec {
  return {
    type,
    operations: RWE,
    flags: 1,
    readable: true,
    writable: true,
    hasEvents: true,
    visible: true,
  };
}

export function makeDp(
  channelAddress: string,
  parameter: string,
  type: ParameterType,
): GenericDataPoint {
  return new GenericDataPoint({
    dpk: makeDpk(INTERFACE_ID, channelAddress, 'VALUES', parameter),
    spec: makeSpec(type),
    interfaceFamily: 'HMIP',
  });
}

/** Build a single-channel HmIP-PS-like switch device with STATE on channel 3. */
export function makeSwitchDevice(): { device: ModelDevice; state: GenericDataPoint } {
  const state = makeDp('VCU0000001:3', 'STATE', ParameterType.BOOL);
  const ch3 = new ModelChannel({
    address: 'VCU0000001:3',
    index: 3,
    type: 'SWITCH_VIRTUAL_RECEIVER',
    dataPoints: [state],
  });
  const device = new ModelDevice({
    address: 'VCU0000001',
    type: 'HmIP-PS',
    interfaceId: INTERFACE_ID,
    channels: [ch3],
  });
  return { device, state };
}

/** A recording writer fake plus the calls it captured. */
export interface RecordingWriter {
  writer: CustomEntityWriter;
  calls: Array<{ channelAddress: string; parameter: string; value: HmValue }>;
}

export function recordingWriter(): RecordingWriter {
  const calls: RecordingWriter['calls'] = [];
  const writer: CustomEntityWriter = async (channelAddress, parameter, value) => {
    calls.push({ channelAddress, parameter, value });
  };
  return { writer, calls };
}
