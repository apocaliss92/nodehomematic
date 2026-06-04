import { describe, it, expect } from 'vitest';
import {
  convertFromCcu,
  convertToCcu,
  validateWritable,
  type HmValue,
} from '../../../src/model/converter.js';
import type { ParameterSpec } from '../../../src/central/graph.js';
import { ParameterType, Operations } from '../../../src/support/constants.js';
import { ValidationError, UnsupportedError } from '../../../src/support/errors.js';

const RWE = Operations.READ | Operations.WRITE | Operations.EVENT;

function makeSpec(overrides: Partial<ParameterSpec> & { type: ParameterType }): ParameterSpec {
  const operations = overrides.operations ?? RWE;
  return {
    type: overrides.type,
    operations,
    flags: overrides.flags ?? 1,
    readable: (operations & Operations.READ) !== 0,
    writable: (operations & Operations.WRITE) !== 0,
    hasEvents: (operations & Operations.EVENT) !== 0,
    visible: true,
    ...(overrides.min !== undefined ? { min: overrides.min } : {}),
    ...(overrides.max !== undefined ? { max: overrides.max } : {}),
    ...(overrides.unit !== undefined ? { unit: overrides.unit } : {}),
    ...(overrides.valueList !== undefined ? { valueList: overrides.valueList } : {}),
  };
}

describe('convertFromCcu', () => {
  it('FLOAT: empty string → null', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT });
    expect(convertFromCcu(spec, '')).toBeNull();
  });

  it('FLOAT: coerces numeric string to number', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT });
    expect(convertFromCcu(spec, '21.5')).toBe(21.5);
  });

  it('FLOAT: non-finite → null', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT });
    expect(convertFromCcu(spec, 'abc')).toBeNull();
  });

  it('INTEGER: empty string → null, number passes through', () => {
    const spec = makeSpec({ type: ParameterType.INTEGER });
    expect(convertFromCcu(spec, '')).toBeNull();
    expect(convertFromCcu(spec, 7)).toBe(7);
  });

  it('BOOL: coerces both ways', () => {
    const spec = makeSpec({ type: ParameterType.BOOL });
    expect(convertFromCcu(spec, 1)).toBe(true);
    expect(convertFromCcu(spec, '1')).toBe(true);
    expect(convertFromCcu(spec, 'true')).toBe(true);
    expect(convertFromCcu(spec, true)).toBe(true);
    expect(convertFromCcu(spec, 0)).toBe(false);
    expect(convertFromCcu(spec, '0')).toBe(false);
    expect(convertFromCcu(spec, 'false')).toBe(false);
    expect(convertFromCcu(spec, false)).toBe(false);
  });

  it('ENUM: numeric index → value list string', () => {
    const spec = makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON', 'AUTO'] });
    expect(convertFromCcu(spec, 1)).toBe('ON');
    expect(convertFromCcu(spec, '2')).toBe('AUTO');
  });

  it('ENUM: already-string in value list passes through', () => {
    const spec = makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON'] });
    expect(convertFromCcu(spec, 'ON')).toBe('ON');
  });

  it('ENUM: out-of-range index → number as-is', () => {
    const spec = makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON'] });
    expect(convertFromCcu(spec, 5)).toBe(5);
  });

  it('ENUM: no value list → number as-is', () => {
    const spec = makeSpec({ type: ParameterType.ENUM });
    expect(convertFromCcu(spec, 3)).toBe(3);
  });

  it('STRING: String(raw)', () => {
    const spec = makeSpec({ type: ParameterType.STRING });
    expect(convertFromCcu(spec, 42)).toBe('42');
  });

  it('ACTION: Boolean(raw)', () => {
    const spec = makeSpec({ type: ParameterType.ACTION });
    expect(convertFromCcu(spec, 1)).toBe(true);
    expect(convertFromCcu(spec, 0)).toBe(false);
  });

  it('unknown type: null for empty, string otherwise', () => {
    const spec = makeSpec({ type: ParameterType.EMPTY });
    expect(convertFromCcu(spec, '')).toBeNull();
    expect(convertFromCcu(spec, null)).toBeNull();
    expect(convertFromCcu(spec, 99)).toBe('99');
  });
});

describe('validateWritable', () => {
  it('throws UnsupportedError when not writable', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT, operations: Operations.READ });
    expect(() => validateWritable(spec)).toThrow(UnsupportedError);
  });

  it('passes when writable', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT });
    expect(() => validateWritable(spec)).not.toThrow();
  });
});

describe('convertToCcu', () => {
  const opts = { enumAsIndex: true };

  it('FLOAT: out-of-range → ValidationError', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT, min: 0, max: 10 });
    expect(() => convertToCcu(spec, 20, opts)).toThrow(ValidationError);
    expect(() => convertToCcu(spec, -1, opts)).toThrow(ValidationError);
  });

  it('FLOAT: in range returns number, coerces numeric string', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT, min: 0, max: 10 });
    expect(convertToCcu(spec, 5, opts)).toBe(5);
    expect(convertToCcu(spec, '5.5', opts)).toBe(5.5);
  });

  it('FLOAT: NaN → ValidationError', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT });
    expect(() => convertToCcu(spec, 'nope', opts)).toThrow(ValidationError);
  });

  it('INTEGER: non-integer → ValidationError', () => {
    const spec = makeSpec({ type: ParameterType.INTEGER });
    expect(() => convertToCcu(spec, 1.5, opts)).toThrow(ValidationError);
  });

  it('INTEGER: integer passes, range enforced', () => {
    const spec = makeSpec({ type: ParameterType.INTEGER, min: 0, max: 5 });
    expect(convertToCcu(spec, 3, opts)).toBe(3);
    expect(() => convertToCcu(spec, 9, opts)).toThrow(ValidationError);
  });

  it('BOOL: coerces to boolean', () => {
    const spec = makeSpec({ type: ParameterType.BOOL });
    expect(convertToCcu(spec, 'true', opts)).toBe(true);
    expect(convertToCcu(spec, 0, opts)).toBe(false);
    expect(convertToCcu(spec, true, opts)).toBe(true);
  });

  it('ENUM enumAsIndex: string → index', () => {
    const spec = makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON', 'AUTO'] });
    expect(convertToCcu(spec, 'AUTO', { enumAsIndex: true })).toBe(2);
  });

  it('ENUM enumAsIndex: number index validated', () => {
    const spec = makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON'] });
    expect(convertToCcu(spec, 1, { enumAsIndex: true })).toBe(1);
    expect(() => convertToCcu(spec, 5, { enumAsIndex: true })).toThrow(ValidationError);
  });

  it('ENUM not enumAsIndex: returns string, validates membership', () => {
    const spec = makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON'] });
    expect(convertToCcu(spec, 'ON', { enumAsIndex: false })).toBe('ON');
    // numeric index resolved to string when not index mode
    expect(convertToCcu(spec, 0, { enumAsIndex: false })).toBe('OFF');
  });

  it('ENUM: unknown string → ValidationError (both modes)', () => {
    const spec = makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON'] });
    expect(() => convertToCcu(spec, 'BOGUS', { enumAsIndex: true })).toThrow(ValidationError);
    expect(() => convertToCcu(spec, 'BOGUS', { enumAsIndex: false })).toThrow(ValidationError);
  });

  it('ENUM string↔index round-trip', () => {
    const spec = makeSpec({ type: ParameterType.ENUM, valueList: ['OFF', 'ON', 'AUTO'] });
    const fromCcu = convertFromCcu(spec, 2);
    expect(fromCcu).toBe('AUTO');
    expect(convertToCcu(spec, fromCcu, { enumAsIndex: true })).toBe(2);
  });

  it('STRING: String(value)', () => {
    const spec = makeSpec({ type: ParameterType.STRING });
    expect(convertToCcu(spec, 123, opts)).toBe('123');
  });

  it('ACTION: returns true', () => {
    const spec = makeSpec({ type: ParameterType.ACTION });
    expect(convertToCcu(spec, false, opts)).toBe(true);
    expect(convertToCcu(spec, null, opts)).toBe(true);
  });

  it('null value for numeric → ValidationError', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT });
    const v: HmValue = null;
    expect(() => convertToCcu(spec, v, opts)).toThrow(ValidationError);
  });

  it('non-writable spec → UnsupportedError before any conversion', () => {
    const spec = makeSpec({ type: ParameterType.FLOAT, operations: Operations.READ });
    expect(() => convertToCcu(spec, 5, opts)).toThrow(UnsupportedError);
  });

  it('unknown type: passes through as String', () => {
    const spec = makeSpec({ type: ParameterType.EMPTY });
    expect(convertToCcu(spec, 'x', opts)).toBe('x');
  });
});
