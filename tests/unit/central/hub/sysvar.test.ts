import { describe, it, expect } from 'vitest';
import {
  HubValueType,
  normalizeType,
  toBool,
  parseSysVarValue,
} from '../../../../src/central/hub/sysvar.js';

describe('toBool', () => {
  it.each(['y', 'yes', 't', 'true', 'on', '1', 'TRUE', 'On', 'YES'])('is true for %s', (s) => {
    expect(toBool(s)).toBe(true);
  });

  it.each(['n', 'no', 'f', 'false', 'off', '0', '', 'anything'])('is false for %s', (s) => {
    expect(toBool(s)).toBe(false);
  });
});

describe('normalizeType', () => {
  it('maps known type names to the enum', () => {
    expect(normalizeType('ALARM', '1')).toBe(HubValueType.ALARM);
    expect(normalizeType('LOGIC', 'true')).toBe(HubValueType.LOGIC);
    expect(normalizeType('LIST', '2')).toBe(HubValueType.LIST);
    expect(normalizeType('STRING', 'hello')).toBe(HubValueType.STRING);
    expect(normalizeType('FLOAT', '1.5')).toBe(HubValueType.FLOAT);
    expect(normalizeType('INTEGER', '3')).toBe(HubValueType.INTEGER);
  });

  it('refines NUMBER to FLOAT when the raw value has a decimal point', () => {
    expect(normalizeType('NUMBER', '21.5')).toBe(HubValueType.FLOAT);
  });

  it('refines NUMBER to INTEGER when the raw value has no decimal point', () => {
    expect(normalizeType('NUMBER', '42')).toBe(HubValueType.INTEGER);
  });
});

describe('parseSysVarValue', () => {
  it('parses ALARM/LOGIC to bool', () => {
    expect(parseSysVarValue(HubValueType.LOGIC, 'true')).toBe(true);
    expect(parseSysVarValue(HubValueType.ALARM, '0')).toBe(false);
  });

  it('parses FLOAT to a number', () => {
    expect(parseSysVarValue(HubValueType.FLOAT, '21.5')).toBe(21.5);
  });

  it('parses INTEGER and LIST to an int', () => {
    expect(parseSysVarValue(HubValueType.INTEGER, '7')).toBe(7);
    expect(parseSysVarValue(HubValueType.LIST, '2')).toBe(2);
  });

  it('passes STRING and NUMBER through as raw strings', () => {
    expect(parseSysVarValue(HubValueType.STRING, 'hello')).toBe('hello');
    expect(parseSysVarValue(HubValueType.NUMBER, '12abc')).toBe('12abc');
  });
});
