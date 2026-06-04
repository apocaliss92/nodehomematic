/**
 * {@link ModelChannel} — a public, structurally-immutable view of one channel of
 * a device. It groups the channel's {@link GenericDataPoint}s and exposes a
 * by-parameter lookup. The data points carry their own live state, but the set
 * of data points (and the channel's identity) is fixed at construction.
 */

import type { GenericDataPoint } from './data-point.js';

/** Construction inputs for a {@link ModelChannel}. */
export interface ModelChannelInit {
  readonly address: string;
  readonly index: number;
  readonly type?: string;
  readonly dataPoints: readonly GenericDataPoint[];
}

export class ModelChannel {
  public readonly address: string;
  public readonly index: number;
  public readonly type?: string;
  public readonly dataPoints: readonly GenericDataPoint[];

  readonly #byParameter: ReadonlyMap<string, GenericDataPoint>;

  public constructor(init: ModelChannelInit) {
    this.address = init.address;
    this.index = init.index;
    if (init.type !== undefined) {
      this.type = init.type;
    }
    this.dataPoints = init.dataPoints;
    this.#byParameter = new Map(init.dataPoints.map((dp) => [dp.parameter, dp]));
  }

  /** Resolve a data point on this channel by its parameter name. */
  public dataPoint(parameter: string): GenericDataPoint | undefined {
    return this.#byParameter.get(parameter);
  }
}
