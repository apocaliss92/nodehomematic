/**
 * {@link ClimateEntity} — the climate custom-entity family, covering HmIP
 * thermostats (eTRV / wall thermostats / temperature+humidity sensors) and the
 * HmIP-HEATING groups, which share the same IP-thermostat semantics.
 *
 * Like every {@link CustomEntity} it owns no value state: getters read the
 * underlying {@link GenericDataPoint}s by {@link Field} role, and commands route
 * converted writes through the injected writer. Fields:
 *   SETPOINT → SET_POINT_TEMPERATURE, TEMPERATURE → ACTUAL_TEMPERATURE,
 *   HUMIDITY → HUMIDITY, SET_POINT_MODE (0 AUTO / 1 MANU / 2 AWAY),
 *   CONTROL_MODE (the write/action mode dp: 0 AUTO / 1 MANU), BOOST_MODE,
 *   ACTIVE_PROFILE (week-program index), LEVEL (valve %), STATE (valve open).
 */

import { CustomEntity } from './base.js';
import { Field } from './fields.js';

/** Temperature below which the thermostat is considered off. */
const OFF_TEMPERATURE = 4.5;
/** Fallback minimum target temperature when dp metadata is absent. */
const FALLBACK_MIN_TEMP = 4.5;
/** Fallback maximum target temperature when dp metadata is absent. */
const FALLBACK_MAX_TEMP = 30.5;
/** SET_POINT_MODE: manual operation. */
const SET_POINT_MODE_MANU = 1;
/** SET_POINT_MODE: away/holiday operation. */
const SET_POINT_MODE_AWAY = 2;
/** CONTROL_MODE write value selecting automatic (week-program) operation. */
const CONTROL_MODE_AUTO = 0;
/** CONTROL_MODE write value selecting manual operation. */
const CONTROL_MODE_MANU = 1;

/** Supported high-level operating modes. */
export type ClimateMode = 'auto' | 'heat' | 'off';
/** Supported presets. */
export type ClimatePreset = 'boost' | 'away' | 'week_program' | 'none';
/** Current heating activity. */
export type ClimateActivity = 'heating' | 'idle' | 'off';

export class ClimateEntity extends CustomEntity {
  public readonly kind = 'climate';

  /** Fixed step for target temperature adjustments. */
  public readonly targetTemperatureStep = 0.5;

  /** The temperature unit reported by climate entities. */
  public readonly temperatureUnit = '°C';

  /** The set of modes this entity supports. */
  public readonly modes: readonly ClimateMode[] = ['auto', 'heat', 'off'];

  /** The measured room temperature, or `null` when unavailable. */
  public get currentTemperature(): number | null {
    return this.#numValue(Field.TEMPERATURE);
  }

  /** The configured target temperature, or `null` when unavailable. */
  public get targetTemperature(): number | null {
    return this.#numValue(Field.SETPOINT);
  }

  /** The measured humidity, or `null` when unavailable. */
  public get currentHumidity(): number | null {
    return this.#numValue(Field.HUMIDITY);
  }

  /** The minimum settable target temperature (from dp metadata, with fallback). */
  public get minTemp(): number {
    const min = this.dp(Field.SETPOINT)?.min;
    return typeof min === 'number' ? min : FALLBACK_MIN_TEMP;
  }

  /** The maximum settable target temperature (from dp metadata, with fallback). */
  public get maxTemp(): number {
    const max = this.dp(Field.SETPOINT)?.max;
    return typeof max === 'number' ? max : FALLBACK_MAX_TEMP;
  }

  /**
   * The high-level operating mode: `off` when the target is at/below the off
   * temperature, `heat` when SET_POINT_MODE is manual, otherwise `auto`.
   */
  public get mode(): ClimateMode {
    const target = this.targetTemperature;
    if (target !== null && target <= OFF_TEMPERATURE) {
      return 'off';
    }
    return this.#numValue(Field.SET_POINT_MODE) === SET_POINT_MODE_MANU ? 'heat' : 'auto';
  }

  /**
   * The active preset: `boost` while boosting, `away` while in away mode,
   * `week_program` when a week program is active, otherwise `none`.
   */
  public get preset(): ClimatePreset {
    if (this.dp(Field.BOOST_MODE)?.value === true) {
      return 'boost';
    }
    if (this.#numValue(Field.SET_POINT_MODE) === SET_POINT_MODE_AWAY) {
      return 'away';
    }
    const profile = this.#numValue(Field.ACTIVE_PROFILE);
    return profile !== null && profile > 0 ? 'week_program' : 'none';
  }

  /**
   * Current heating activity: `off` when the mode is off, `heating` when the
   * valve LEVEL is positive or the valve STATE is open, otherwise `idle`.
   */
  public get activity(): ClimateActivity {
    if (this.mode === 'off') {
      return 'off';
    }
    const level = this.#numValue(Field.LEVEL);
    if (level !== null && level > 0) {
      return 'heating';
    }
    if (this.dp(Field.STATE)?.value === true) {
      return 'heating';
    }
    return 'idle';
  }

  /** Set the target temperature, clamped to `[minTemp, maxTemp]`. */
  public async setTemperature(temperature: number): Promise<void> {
    const clamped = Math.min(Math.max(temperature, this.minTemp), this.maxTemp);
    await this.write(Field.SETPOINT, clamped);
  }

  /**
   * Switch operating mode. `auto`/`heat` set CONTROL_MODE; `off` switches to
   * manual then drops the target to the off temperature.
   */
  public async setMode(mode: ClimateMode): Promise<void> {
    if (mode === 'auto') {
      await this.write(Field.CONTROL_MODE, CONTROL_MODE_AUTO);
      return;
    }
    if (mode === 'heat') {
      await this.write(Field.CONTROL_MODE, CONTROL_MODE_MANU);
      return;
    }
    // off: switch to manual, then set the off temperature.
    await this.write(Field.CONTROL_MODE, CONTROL_MODE_MANU);
    await this.write(Field.SETPOINT, OFF_TEMPERATURE);
  }

  /** Enable or disable boost mode. */
  public async setBoost(on: boolean): Promise<void> {
    await this.write(Field.BOOST_MODE, on);
  }

  /** Select the active week-program index. */
  public async setProfile(index: number): Promise<void> {
    await this.write(Field.ACTIVE_PROFILE, index);
  }

  /** Read a field's numeric value, or `null` when absent/non-numeric. */
  #numValue(field: Field): number | null {
    const value = this.dp(field)?.value;
    return typeof value === 'number' ? value : null;
  }
}
