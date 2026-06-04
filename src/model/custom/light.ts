/**
 * {@link DimmerEntity} — the dimmable-light custom-entity family. A dimmer's
 * brightness is the `LEVEL` float (0..1) on its primary channel; user-facing
 * brightness is 0..255. Like every {@link CustomEntity} it owns no value state:
 * the getters read the underlying `LEVEL` data point and commands route
 * converted writes through the injected writer.
 */

import { CustomEntity } from './base.js';
import { Field } from './fields.js';
import { brightnessToLevel, levelToBrightness } from './helpers.js';

/** Default brightness used by {@link DimmerEntity.turnOn} (full on). */
const FULL_BRIGHTNESS = 255;

export class DimmerEntity extends CustomEntity {
  public readonly kind = 'light';

  /** User-facing brightness 0..255 from LEVEL, or `null` when unavailable. */
  public get brightness(): number | null {
    const level = this.#level;
    return level === null ? null : levelToBrightness(level);
  }

  /** True when the dimmer LEVEL is positive. */
  public get isOn(): boolean {
    const level = this.#level;
    return level !== null && level > 0;
  }

  /** Turn the light on at `brightness` (0..255), full on by default. */
  public async turnOn(brightness: number = FULL_BRIGHTNESS): Promise<void> {
    await this.write(Field.LEVEL, brightnessToLevel(brightness));
  }

  /** Turn the light off (LEVEL 0). */
  public async turnOff(): Promise<void> {
    await this.write(Field.LEVEL, 0);
  }

  /** Set the brightness (0..255) by writing the converted LEVEL. */
  public async setBrightness(brightness: number): Promise<void> {
    await this.write(Field.LEVEL, brightnessToLevel(brightness));
  }

  /** The current LEVEL (0..1), or `null` when absent/non-numeric. */
  get #level(): number | null {
    const value = this.dp(Field.LEVEL)?.value;
    return typeof value === 'number' ? value : null;
  }
}
