/**
 * {@link CustomEntity} — a typed domain view aggregating several
 * {@link GenericDataPoint}s of one device by their {@link Field} role.
 *
 * A custom entity owns no value state of its own: high-level getters read the
 * underlying data points' live values, and commands route through an injected
 * {@link CustomEntityWriter} (the single validated write path). This keeps the
 * model the source of truth and the network concern out of the entity.
 */

import { DescriptionNotFoundError } from '../../support/errors.js';
import type { HmValue } from '../converter.js';
import type { GenericDataPoint } from '../data-point.js';
import { Field } from './fields.js';

/**
 * Command sink injected into every custom entity. Implementations resolve the
 * data point for `(channelAddress, parameter)` and perform validate + convert +
 * send (the same path as `Homematic.setValue`). Tests inject a recording fake.
 */
export type CustomEntityWriter = (
  channelAddress: string,
  parameter: string,
  value: HmValue,
) => Promise<void>;

/** Construction inputs for a {@link CustomEntity}. */
export interface CustomEntityInit {
  readonly deviceAddress: string;
  readonly primaryChannelAddress: string;
  readonly type: string;
  readonly dataPoints: Map<Field, GenericDataPoint>;
  readonly writer: CustomEntityWriter;
}

export abstract class CustomEntity {
  public readonly deviceAddress: string;
  public readonly primaryChannelAddress: string;
  public readonly type: string;

  /** Discriminator for the public union (e.g. `switch`, `climate`). */
  public abstract readonly kind: string;

  readonly #dataPoints: ReadonlyMap<Field, GenericDataPoint>;
  readonly #writer: CustomEntityWriter;

  public constructor(init: CustomEntityInit) {
    this.deviceAddress = init.deviceAddress;
    this.primaryChannelAddress = init.primaryChannelAddress;
    this.type = init.type;
    this.#dataPoints = new Map(init.dataPoints);
    this.#writer = init.writer;
  }

  /** The resolved data point for a field, or `undefined` if absent. */
  protected dp(field: Field): GenericDataPoint | undefined {
    return this.#dataPoints.get(field);
  }

  /** The resolved data point for a field; throws if it was not resolved. */
  protected requireDp(field: Field): GenericDataPoint {
    const dp = this.#dataPoints.get(field);
    if (dp === undefined) {
      throw new DescriptionNotFoundError(
        `Field ${field} is not available on ${this.kind} entity ${this.primaryChannelAddress}`,
      );
    }
    return dp;
  }

  /** Resolve the data point for a field and route a converted write to it. */
  protected async write(field: Field, value: HmValue): Promise<void> {
    const dp = this.requireDp(field);
    await this.#writer(dp.dpk.channelAddress, dp.parameter, value);
  }

  /** True when at least one underlying data point was resolved. */
  public get available(): boolean {
    return this.#dataPoints.size > 0;
  }

  /**
   * Subscribe to changes of every underlying data point. Returns a single
   * unsubscribe function that detaches all of them.
   */
  public subscribe(cb: () => void): () => void {
    const unsubscribers: Array<() => void> = [];
    for (const dp of this.#dataPoints.values()) {
      unsubscribers.push(dp.subscribe(() => cb()));
    }
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }
}
