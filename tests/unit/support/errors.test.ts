import { describe, it, expect } from 'vitest';
import {
  BaseHomematicError,
  ClientError,
  UnsupportedError,
  ValidationError,
  NoConnectionError,
  CircuitBreakerOpenError,
  NoClientsError,
  AuthFailureError,
  InternalBackendError,
  CommandSupersededError,
  DescriptionNotFoundError,
  TimeoutError,
  mapXmlRpcFault,
  mapJsonRpcError,
  mapTransportError,
  exceptionToFailureReason,
  FailureReason,
} from '../../../src/support/errors.js';

describe('support/errors taxonomy', () => {
  const cases: Array<[new (msg?: string) => BaseHomematicError, string]> = [
    [ClientError, 'ClientError'],
    [UnsupportedError, 'UnsupportedError'],
    [ValidationError, 'ValidationError'],
    [NoConnectionError, 'NoConnectionError'],
    [CircuitBreakerOpenError, 'CircuitBreakerOpenError'],
    [NoClientsError, 'NoClientsError'],
    [AuthFailureError, 'AuthFailureError'],
    [InternalBackendError, 'InternalBackendError'],
    [CommandSupersededError, 'CommandSupersededError'],
    [DescriptionNotFoundError, 'DescriptionNotFoundError'],
  ];

  for (const [Ctor, name] of cases) {
    it(`${name} estende BaseHomematicError e ha name corretto`, () => {
      const err = new Ctor('boom');
      expect(err).toBeInstanceOf(BaseHomematicError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.message).toBe('boom');
    });
  }

  it('BaseHomematicError preserva la stack e instanceof', () => {
    const err = new ClientError('x');
    expect(err.stack).toBeDefined();
    expect(err instanceof ClientError).toBe(true);
  });
});

describe('mapXmlRpcFault (per stringa)', () => {
  it('"unauthorized" → AuthFailureError', () => {
    const err = mapXmlRpcFault(-1, 'Unauthorized access');
    expect(err).toBeInstanceOf(AuthFailureError);
  });

  it('"internal" → InternalBackendError', () => {
    const err = mapXmlRpcFault(0, 'internal blah');
    expect(err).toBeInstanceOf(InternalBackendError);
  });

  it('altro → ClientError, riportando code e faultString', () => {
    const err = mapXmlRpcFault(0, 'weird');
    expect(err).toBeInstanceOf(ClientError);
    expect(err.message).toContain('weird');
    expect(err.message).toContain('0');
  });
});

describe('mapJsonRpcError (per contenuto messaggio / code)', () => {
  it('code -32001 → AuthFailureError', () => {
    expect(mapJsonRpcError({ code: -32001, message: 'nope' })).toBeInstanceOf(AuthFailureError);
  });

  it('code 401 → AuthFailureError', () => {
    expect(mapJsonRpcError({ code: 401, message: 'nope' })).toBeInstanceOf(AuthFailureError);
  });

  it('message "access denied: ..." → AuthFailureError', () => {
    expect(mapJsonRpcError({ message: 'access denied: bad user' })).toBeInstanceOf(
      AuthFailureError,
    );
  });

  it('code -32603 → InternalBackendError', () => {
    expect(mapJsonRpcError({ code: -32603 })).toBeInstanceOf(InternalBackendError);
  });

  it('code 500 → InternalBackendError', () => {
    expect(mapJsonRpcError({ code: 500 })).toBeInstanceOf(InternalBackendError);
  });

  it('message "internal error" → InternalBackendError', () => {
    expect(mapJsonRpcError({ message: 'internal error happened' })).toBeInstanceOf(
      InternalBackendError,
    );
  });

  it('altro → ClientError', () => {
    expect(mapJsonRpcError({ code: 42, message: 'something' })).toBeInstanceOf(ClientError);
  });
});

describe('mapTransportError', () => {
  it('errore OSError-like (ECONNREFUSED) → NoConnectionError', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(mapTransportError(e)).toBeInstanceOf(NoConnectionError);
  });

  it('AbortError/Timeout → NoConnectionError', () => {
    const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(mapTransportError(e)).toBeInstanceOf(NoConnectionError);
  });

  it('errore generico → ClientError', () => {
    expect(mapTransportError(new Error('whatever'))).toBeInstanceOf(ClientError);
  });

  it('valore non-Error → ClientError', () => {
    expect(mapTransportError('nope')).toBeInstanceOf(ClientError);
  });
});

describe('exceptionToFailureReason', () => {
  it('AuthFailureError → AUTH', () => {
    expect(exceptionToFailureReason(new AuthFailureError())).toBe(FailureReason.AUTH);
  });
  it('NoConnectionError → NETWORK', () => {
    expect(exceptionToFailureReason(new NoConnectionError())).toBe(FailureReason.NETWORK);
  });
  it('InternalBackendError → INTERNAL', () => {
    expect(exceptionToFailureReason(new InternalBackendError())).toBe(FailureReason.INTERNAL);
  });
  it('CircuitBreakerOpenError → CIRCUIT_BREAKER', () => {
    expect(exceptionToFailureReason(new CircuitBreakerOpenError())).toBe(
      FailureReason.CIRCUIT_BREAKER,
    );
  });
  it('TimeoutError → TIMEOUT', () => {
    expect(exceptionToFailureReason(new TimeoutError())).toBe(FailureReason.TIMEOUT);
  });
  it('altro → UNKNOWN', () => {
    expect(exceptionToFailureReason(new Error('x'))).toBe(FailureReason.UNKNOWN);
  });
});
