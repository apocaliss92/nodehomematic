import { describe, it, expect } from 'vitest';
import {
  brightnessToLevel,
  levelToBrightness,
  positionToLevel,
  levelToPosition,
} from '../../../../src/model/custom/helpers.js';

describe('custom helpers', () => {
  it('brightnessToLevel maps and clamps 0..255 → 0..1', () => {
    expect(brightnessToLevel(0)).toBe(0);
    expect(brightnessToLevel(255)).toBe(1);
    expect(brightnessToLevel(-10)).toBe(0);
    expect(brightnessToLevel(300)).toBe(1);
    expect(brightnessToLevel(128)).toBeCloseTo(128 / 255);
  });

  it('levelToBrightness maps and clamps 0..1 → 0..255 int', () => {
    expect(levelToBrightness(0)).toBe(0);
    expect(levelToBrightness(1)).toBe(255);
    expect(levelToBrightness(2)).toBe(255);
    expect(levelToBrightness(-1)).toBe(0);
    expect(levelToBrightness(0.5)).toBe(128);
  });

  it('positionToLevel maps and clamps 0..100 → 0..1', () => {
    expect(positionToLevel(0)).toBe(0);
    expect(positionToLevel(100)).toBe(1);
    expect(positionToLevel(150)).toBe(1);
    expect(positionToLevel(50)).toBe(0.5);
  });

  it('levelToPosition maps and clamps 0..1 → 0..100 int', () => {
    expect(levelToPosition(0)).toBe(0);
    expect(levelToPosition(1)).toBe(100);
    expect(levelToPosition(0.5)).toBe(50);
    expect(levelToPosition(2)).toBe(100);
  });
});
