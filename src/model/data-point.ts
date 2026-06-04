/**
 * {@link GenericDataPoint} — a single live value point in the domain model.
 *
 * It binds a {@link DataPointKey} (its identity/routing key) to a typed
 * {@link ParameterSpec} (its metadata) and holds the current converted value.
 * Inbound CCU events flow through {@link GenericDataPoint.applyCcuValue} (which
 * converts + updates state + notifies subscribers on change); outbound writes
 * are validated and converted by {@link GenericDataPoint.prepareWrite}.
 *
 * State lives inside the data point, but its identity and metadata are fixed at
 * construction. The CCU is the source of truth for the value; subscribers are
 * notified only when the converted value actually changes.
 */

import type { ParameterSpec } from '../central/graph.js';
import type { ParameterType } from '../support/constants.js';
import { type DataPointKey, dpkToUniqueId } from '../support/dpk.js';
import { convertFromCcu, convertToCcu, type HmValue } from './converter.js';

/** The interface family, which governs ENUM serialisation on writes. */
export type InterfaceFamily = 'HM' | 'HMIP';

/** Construction inputs for a {@link GenericDataPoint}. */
export interface GenericDataPointInit {
  readonly dpk: DataPointKey;
  readonly spec: ParameterSpec;
  readonly interfaceFamily: InterfaceFamily;
}

/** Result of applying an inbound CCU value. */
export interface ApplyResult {
  readonly changed: boolean;
  readonly prev: HmValue;
  readonly next: HmValue;
}

/** A subscriber notified with `(next, prev)` whenever the value changes. */
export type ValueListener = (next: HmValue, prev: HmValue) => void;

export class GenericDataPoint {
  readonly #dpk: DataPointKey;
  readonly #spec: ParameterSpec;
  readonly #interfaceFamily: InterfaceFamily;
  readonly #id: string;
  readonly #listeners = new Set<ValueListener>();

  #value: HmValue = null;
  #lastUpdatedAt: number | undefined = undefined;

  public constructor(init: GenericDataPointInit) {
    this.#dpk = init.dpk;
    this.#spec = init.spec;
    this.#interfaceFamily = init.interfaceFamily;
    this.#id = dpkToUniqueId(init.dpk);
  }

  /** Stable, lowercased unique id derived from the dpk. */
  public get id(): string {
    return this.#id;
  }

  /** The routing key identifying this value point. */
  public get dpk(): DataPointKey {
    return this.#dpk;
  }

  /** The parameter name, e.g. `STATE`. */
  public get parameter(): string {
    return this.#dpk.parameter;
  }

  /** The parameter value type. */
  public get type(): ParameterType {
    return this.#spec.type;
  }

  public get readable(): boolean {
    return this.#spec.readable;
  }

  public get writable(): boolean {
    return this.#spec.writable;
  }

  public get hasEvents(): boolean {
    return this.#spec.hasEvents;
  }

  public get visible(): boolean {
    return this.#spec.visible;
  }

  public get unit(): string | undefined {
    return this.#spec.unit;
  }

  public get valueList(): readonly string[] | undefined {
    return this.#spec.valueList;
  }

  public get min(): unknown {
    return this.#spec.min;
  }

  public get max(): unknown {
    return this.#spec.max;
  }

  /** The current converted value (default `null` until the first event). */
  public get value(): HmValue {
    return this.#value;
  }

  /** Epoch-ms timestamp of the last `applyCcuValue`, or `undefined`. */
  public get lastUpdatedAt(): number | undefined {
    return this.#lastUpdatedAt;
  }

  /**
   * Apply a raw inbound CCU value: convert it, update the current value and
   * timestamp, and notify subscribers when (and only when) the value changed.
   */
  public applyCcuValue(raw: unknown, at: number): ApplyResult {
    const prev = this.#value;
    const next = convertFromCcu(this.#spec, raw);
    this.#value = next;
    this.#lastUpdatedAt = at;
    const changed = prev !== next;
    if (changed) {
      this.#notify(next, prev);
    }
    return { changed, prev, next };
  }

  /**
   * Validate (writable + range/membership) and convert a JS value to its CCU
   * wire representation. ENUM is serialised as an index for HM interfaces and
   * as a string for HmIP interfaces.
   */
  public prepareWrite(value: HmValue): boolean | number | string {
    const enumAsIndex = this.#interfaceFamily === 'HM';
    return convertToCcu(this.#spec, value, { enumAsIndex });
  }

  /** Subscribe to value changes. Returns an unsubscribe function. */
  public subscribe(cb: ValueListener): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  #notify(next: HmValue, prev: HmValue): void {
    for (const listener of this.#listeners) {
      listener(next, prev);
    }
  }
}
