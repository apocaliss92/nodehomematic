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

/** DIRECTION value reported while the cover is opening. */
const DIRECTION_UP = 'UP';
/** DIRECTION value reported while the cover is closing. */
const DIRECTION_DOWN = 'DOWN';

export class CoverEntity extends CustomEntity {
  public readonly kind: string = 'cover';

  /** Current position 0..100 from LEVEL, or `null` when unavailable. */
  public get currentPosition(): number | null {
    const level = this.level;
    return level === null ? null : levelToPosition(level);
  }

  /** True when the cover is fully closed (LEVEL 0). */
  public get isClosed(): boolean {
    return this.level === 0;
  }

  /** True while the cover is travelling open (DIRECTION 'UP'). */
  public get isOpening(): boolean {
    return this.dp(Field.DIRECTION)?.value === DIRECTION_UP;
  }

  /** True while the cover is travelling closed (DIRECTION 'DOWN'). */
  public get isClosing(): boolean {
    return this.dp(Field.DIRECTION)?.value === DIRECTION_DOWN;
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
