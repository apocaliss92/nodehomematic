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
  /**
   * READ bindings that differ from the command binding, by field.
   *
   * Most fields are one data point: you read it and you write it. A few are
   * not, and a cover is the case that forced this — measured on a live CCU,
   * HmIP-BROLL `00111BE992A8E5`:
   *
   *   :3 SHUTTER_TRANSMITTER       LEVEL 0.475  R-E   ← where it IS
   *   :4 SHUTTER_VIRTUAL_RECEIVER  LEVEL 1.0    RWE   ← where you COMMAND
   *
   * The transmitter is the device reporting itself and its LEVEL is not
   * writable; the virtual receiver is the link/group target and holds the last
   * commanded extreme. Binding both to the receiver — which is what this
   * library did — reports 0 or 100 and nothing between, and is simply WRONG
   * whenever the shutter rests part-way: 100 while the slat sat at 47.5 %.
   *
   * Absent for a field ⇒ read and write are the same data point, as before.
   */
  readonly readDataPoints?: Map<Field, GenericDataPoint>;
  readonly writer: CustomEntityWriter;
}

export abstract class CustomEntity {
  public readonly deviceAddress: string;
  public readonly primaryChannelAddress: string;
  public readonly type: string;

  /** Discriminator for the public union (e.g. `switch`, `climate`). */
  public abstract readonly kind: string;

  readonly #dataPoints: ReadonlyMap<Field, GenericDataPoint>;
  readonly #readDataPoints: ReadonlyMap<Field, GenericDataPoint>;
  readonly #writer: CustomEntityWriter;

  public constructor(init: CustomEntityInit) {
    this.deviceAddress = init.deviceAddress;
    this.primaryChannelAddress = init.primaryChannelAddress;
    this.type = init.type;
    this.#dataPoints = new Map(init.dataPoints);
    this.#readDataPoints = new Map(init.readDataPoints ?? []);
    this.#writer = init.writer;
  }

  /**
   * The data point a field is READ from — its read binding when it has one,
   * the command binding otherwise.
   *
   * Every getter goes through here; {@link write} deliberately does not, so a
   * field whose status lives on another channel is still commanded where the
   * CCU accepts writes.
   */
  protected dp(field: Field): GenericDataPoint | undefined {
    return this.#readDataPoints.get(field) ?? this.#dataPoints.get(field);
  }

  /** The data point a field is WRITTEN to. Never the read binding. */
  protected writeDp(field: Field): GenericDataPoint | undefined {
    return this.#dataPoints.get(field);
  }

  /** The resolved data point for a field; throws if it was not resolved. */
  protected requireDp(field: Field): GenericDataPoint {
    const dp = this.dp(field);
    if (dp === undefined) {
      throw new DescriptionNotFoundError(
        `Field ${field} is not available on ${this.kind} entity ${this.primaryChannelAddress}`,
      );
    }
    return dp;
  }

  /** Resolve the data point for a field and route a converted write to it. */
  protected async write(field: Field, value: HmValue): Promise<void> {
    // The COMMAND binding, never the read one: a transmitter channel reports
    // the truth and refuses writes (`OPERATIONS` R-E), so routing a command
    // there would fail on the CCU while looking right here.
    const dp = this.writeDp(field);
    if (dp === undefined) {
      throw new DescriptionNotFoundError(
        `Field ${field} is not writable on ${this.kind} entity ${this.primaryChannelAddress}`,
      );
    }
    await this.#writer(dp.dpk.channelAddress, dp.parameter, value);
  }

  /**
   * Every channel this entity touches — command bindings and read bindings —
   * de-duplicated, in a stable order.
   *
   * A consumer that watches events per channel needs this: an HmIP cover reads
   * its position on the transmitter and is commanded on the virtual receiver,
   * so filtering events by {@link primaryChannelAddress} alone drops exactly
   * the reports the entity exists to expose. That happened downstream and cost
   * an evening — the library resolved the right channel and the consumer threw
   * its events away.
   */
  public get channelAddresses(): readonly string[] {
    const seen = new Set<string>();
    for (const dp of [...this.#dataPoints.values(), ...this.#readDataPoints.values()]) {
      seen.add(dp.dpk.channelAddress);
    }
    return [...seen];
  }

  /**
   * The channels this entity READS from, when those differ from where it is
   * commanded. Empty when every field is read where it is written.
   *
   * Separate from {@link channelAddresses} because knowing the union is not
   * enough for a consumer that watches raw parameter events: an HmIP cover
   * carries `LEVEL` on BOTH the transmitter and the virtual receiver, so
   * accepting both and taking the last arrival is a coin toss that the
   * receiver wins — 100 % against a slat at 47.5 %. A parameter available on a
   * status channel must be taken from THERE and nowhere else.
   */
  public get statusChannelAddresses(): readonly string[] {
    const seen = new Set<string>();
    for (const dp of this.#readDataPoints.values()) seen.add(dp.dpk.channelAddress);
    return [...seen];
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
    // BOTH maps, de-duplicated. A field whose status lives on another channel
    // changes THERE, so subscribing to the command bindings alone would leave
    // a consumer never woken by the value it actually reads — the fix above
    // would be invisible to anybody watching.
    const seen = new Set<GenericDataPoint>();
    for (const dp of [...this.#dataPoints.values(), ...this.#readDataPoints.values()]) {
      if (seen.has(dp)) continue;
      seen.add(dp);
      unsubscribers.push(dp.subscribe(() => cb()));
    }
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }
}
