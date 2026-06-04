/**
 * Pure numeric conversions between user-facing scales (brightness 0..255,
 * position 0..100) and the CCU `LEVEL` domain (0..1 float). Inputs are clamped
 * to their valid range; the reverse conversions round to an integer.
 */

/** Clamp `n` to the inclusive `[min, max]` range. */
function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Brightness 0..255 → LEVEL 0..1 (clamped). */
export function brightnessToLevel(brightness: number): number {
  return clamp(brightness, 0, 255) / 255;
}

/** LEVEL 0..1 → brightness 0..255 (clamped, rounded to int). */
export function levelToBrightness(level: number): number {
  return Math.round(clamp(level, 0, 1) * 255);
}

/** Position 0..100 → LEVEL 0..1 (clamped). */
export function positionToLevel(position: number): number {
  return clamp(position, 0, 100) / 100;
}

/** LEVEL 0..1 → position 0..100 (clamped, rounded to int). */
export function levelToPosition(level: number): number {
  return Math.round(clamp(level, 0, 1) * 100);
}
