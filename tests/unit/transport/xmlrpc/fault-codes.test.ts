import { describe, it, expect } from 'vitest';
import {
  XmlRpcFaultCode,
  RETRYABLE_FAULT_CODES,
  isRetryableFaultCode,
} from '../../../../src/transport/xmlrpc/fault-codes.js';

describe('fault-codes', () => {
  it('enum riporta i valori di protocollo', () => {
    expect(XmlRpcFaultCode.GENERIC).toBe(-1);
    expect(XmlRpcFaultCode.INSUFFICIENT_DUTYCYCLE).toBe(-8);
    expect(XmlRpcFaultCode.TRANSMISSION_PENDING).toBe(-10);
  });

  it('RETRYABLE_FAULT_CODES = {-1,-8,-9,-10}', () => {
    expect([...RETRYABLE_FAULT_CODES].sort((a, b) => a - b)).toEqual([-10, -9, -8, -1]);
  });

  it('isRetryableFaultCode discrimina correttamente', () => {
    expect(isRetryableFaultCode(-1)).toBe(true);
    expect(isRetryableFaultCode(-8)).toBe(true);
    expect(isRetryableFaultCode(-9)).toBe(true);
    expect(isRetryableFaultCode(-10)).toBe(true);
    expect(isRetryableFaultCode(-2)).toBe(false);
    expect(isRetryableFaultCode(0)).toBe(false);
  });
});
