/**
 * {@link Field} — stable internal keys identifying the role a data point plays
 * inside a custom entity (e.g. the on/off STATE, the dimmer LEVEL, the climate
 * SETPOINT). A field is mapped to a concrete CCU parameter on a concrete channel
 * by a {@link FieldMapping} inside a profile config. The field is the abstract
 * concept; the parameter is the wire name on the CCU.
 */

/** Stable internal field keys. The value is intentionally a readable string. */
export enum Field {
  STATE = 'STATE',
  LEVEL = 'LEVEL',
  LEVEL_2 = 'LEVEL_2',
  STOP = 'STOP',
  DIRECTION = 'DIRECTION',
  SETPOINT = 'SETPOINT',
  TEMPERATURE = 'TEMPERATURE',
  HUMIDITY = 'HUMIDITY',
  SET_POINT_MODE = 'SET_POINT_MODE',
  CONTROL_MODE = 'CONTROL_MODE',
  BOOST_MODE = 'BOOST_MODE',
  ACTIVE_PROFILE = 'ACTIVE_PROFILE',
  LOCK_STATE = 'LOCK_STATE',
  LOCK_TARGET_LEVEL = 'LOCK_TARGET_LEVEL',
  OPEN = 'OPEN',
  COLOR = 'COLOR',
  HUE = 'HUE',
  SATURATION = 'SATURATION',
  COLOR_TEMPERATURE = 'COLOR_TEMPERATURE',
  ON_TIME_VALUE = 'ON_TIME_VALUE',
  GROUP_STATE = 'GROUP_STATE',
}

/**
 * Maps a {@link Field} to the CCU `parameter` string on a channel.
 *
 * @property field   — the abstract field this mapping fills.
 * @property parameter — the CCU parameter name (e.g. `STATE`, `LEVEL`).
 * @property visible — whether the underlying data point should be considered
 *   user-visible when consumed by a custom entity (informational only here).
 * @property channelOffset — RELATIVE offset from the entity's primary channel
 *   at which the parameter lives. Defaults to `0` (the primary channel itself).
 */
export interface FieldMapping {
  readonly field: Field;
  readonly parameter: string;
  readonly visible?: boolean;
  readonly channelOffset?: number;
}
