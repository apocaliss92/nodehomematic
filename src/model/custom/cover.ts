/**
 * {@link CoverEntity} and {@link BlindEntity} — the cover/blind custom-entity
 * family. A cover's position is the `LEVEL` float (0..1) on its primary channel;
 * user-facing position is 0..100. `STOP` is an action and `DIRECTION` reports
 * the current travel ('UP'/'DOWN'/…). A blind additionally exposes slat tilt via
 * a second `LEVEL_2` float.
 *
 * Like every {@link CustomEntity} these own no value state: getters read the
 * underlying data points and commands route converted writes through the writer.
 */

import { CustomEntity } from './base.js';
import { Field } from './fields.js';
import { levelToPosition, positionToLevel } from './helpers.js';

/**
 * What a cover's travel data point says.
 *
 * `stable` and `unknown` are deliberately NOT the same answer. HmIP's
 * `ACTIVITY_STATE` carries both and means different things by them — measured
 * on a live CCU, channel 4 of an HmIP-BROLL:
 *
 *     ACTIVITY_STATE  TYPE=ENUM  VALUE_LIST = UNKNOWN|UP|DOWN|STABLE
 *
 * `STABLE` is "it has come to rest"; `UNKNOWN` is the parameter's DEFAULT and
 * means the CCU has no opinion yet. A consumer that folds the two together
 * ends a move on a report that never claimed it ended.
 */
export type CoverTravel = 'opening' | 'closing' | 'stable' | 'unknown';

/**
 * The travel members, by NAME, across both families.
 *
 * Matched by name rather than by index because the two value lists differ in
 * their MEMBERS and not merely their order: RF `DIRECTION` is
 * `NONE|UP|DOWN|UNDEFINED`, HmIP `ACTIVITY_STATE` is `UNKNOWN|UP|DOWN|STABLE`.
 * An index mapping would be a guess about a list that is right there in the
 * data point's own spec.
 */
const TRAVEL_BY_NAME: Readonly<Record<string, CoverTravel>> = {
  UP: 'opening',
  DOWN: 'closing',
  STABLE: 'stable',
  NONE: 'stable',
  UNKNOWN: 'unknown',
  UNDEFINED: 'unknown',
};

export class CoverEntity extends CustomEntity {
  public readonly kind: string = 'cover';

  /** Current position 0..100 from LEVEL, or `null` when unavailable. */
  public get currentPosition(): number | null {
    const level = this.level;
    return level === null ? null : levelToPosition(level);
  }

  /**
   * True when the cover is fully closed (LEVEL 0).
   *
   * `false` here covers BOTH "open" and "LEVEL has not been read yet" — check
   * {@link currentPosition} for `null` to tell them apart. Kept as a plain
   * boolean because narrowing it would change every caller's type.
   */
  public get isClosed(): boolean {
    return this.level === 0;
  }

  /**
   * What the cover is doing, from its travel data point.
   *
   * The data point is `ACTIVITY_STATE` on HmIP and `DIRECTION` on RF; the
   * profile maps whichever one the device has onto {@link Field.DIRECTION}, so
   * this getter never needs to know which family it is looking at.
   *
   * The ENUM arrives already converted to its value-list member (the inbound
   * converter resolves the CCU's index), so this reads names. A numeric value
   * means the list could not be resolved: index 0 is the non-travelling member
   * in both families, 1 is up and 2 is down.
   */
  public get travel(): CoverTravel {
    const value = this.dp(Field.DIRECTION)?.value;
    if (typeof value === 'string') {
      return TRAVEL_BY_NAME[value.toUpperCase()] ?? 'unknown';
    }
    if (typeof value === 'number') {
      if (value === 0) return 'stable';
      if (value === 1) return 'opening';
      if (value === 2) return 'closing';
    }
    return 'unknown';
  }

  /** True while the cover is travelling open. */
  public get isOpening(): boolean {
    return this.travel === 'opening';
  }

  /** True while the cover is travelling closed. */
  public get isClosing(): boolean {
    return this.travel === 'closing';
  }

  /** Open the cover fully (LEVEL 1). */
  public async open(): Promise<void> {
    await this.write(Field.LEVEL, 1);
  }

  /** Close the cover fully (LEVEL 0). */
  public async close(): Promise<void> {
    await this.write(Field.LEVEL, 0);
  }

  /** Stop the cover where it is. */
  public async stop(): Promise<void> {
    await this.write(Field.STOP, true);
  }

  /** Move the cover to `position` (0..100) via the converted LEVEL. */
  public async setPosition(position: number): Promise<void> {
    await this.write(Field.LEVEL, positionToLevel(position));
  }

  /** The current LEVEL (0..1), or `null` when absent/non-numeric. */
  protected get level(): number | null {
    const value = this.dp(Field.LEVEL)?.value;
    return typeof value === 'number' ? value : null;
  }
}

export class BlindEntity extends CoverEntity {
  public override readonly kind: string = 'blind';

  /** Current slat tilt 0..100 from LEVEL_2, or `null` when unavailable. */
  public get currentTiltPosition(): number | null {
    const value = this.dp(Field.LEVEL_2)?.value;
    return typeof value === 'number' ? levelToPosition(value) : null;
  }

  /**
   * Move the blind to `position` (0..100), and when `tilt` (0..100) is given,
   * also set the slat tilt via LEVEL_2. LEVEL is written first.
   */
  public override async setPosition(position: number, tilt?: number): Promise<void> {
    await this.write(Field.LEVEL, positionToLevel(position));
    if (tilt !== undefined) {
      await this.write(Field.LEVEL_2, positionToLevel(tilt));
    }
  }
}
