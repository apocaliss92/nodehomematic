import { describe, it, expect } from 'vitest';
import { LIBRARY_NAME, isSupportedNodeVersion } from '../../src/support/version.js';

describe('support/version', () => {
  it('espone il nome libreria', () => {
    expect(LIBRARY_NAME).toBe('nodehomematic');
  });

  it('accetta Node >= 20', () => {
    expect(isSupportedNodeVersion('v20.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.19.0')).toBe(true);
  });

  it('rifiuta Node < 20', () => {
    expect(isSupportedNodeVersion('v18.20.0')).toBe(false);
  });

  it('rifiuta stringhe non riconoscibili come versione', () => {
    expect(isSupportedNodeVersion('not-a-version')).toBe(false);
  });
});
