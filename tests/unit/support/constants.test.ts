import { describe, it, expect } from 'vitest';
import {
  Interface,
  INTERFACE_PORTS,
  JSON_RPC_PATH,
  ENCODING_OUT,
  ENCODING_IN,
  TIMEOUTS,
  interfaceId,
} from '../../../src/support/constants.js';

describe('support/constants', () => {
  it('Interface enum espone le interfacce note', () => {
    expect(Interface.BIDCOS_RF).toBe('BidCos-RF');
    expect(Interface.HMIP_RF).toBe('HmIP-RF');
    expect(Interface.BIDCOS_WIRED).toBe('BidCos-Wired');
    expect(Interface.VIRTUAL_DEVICES).toBe('VirtualDevices');
  });

  it('INTERFACE_PORTS mappa nonTls/tls per ogni interfaccia', () => {
    expect(INTERFACE_PORTS[Interface.BIDCOS_RF]).toEqual({ nonTls: 2001, tls: 42001 });
    expect(INTERFACE_PORTS[Interface.HMIP_RF]).toEqual({ nonTls: 2010, tls: 42010 });
    expect(INTERFACE_PORTS[Interface.BIDCOS_WIRED]).toEqual({ nonTls: 2000, tls: 42000 });
    expect(INTERFACE_PORTS[Interface.VIRTUAL_DEVICES]).toEqual({ nonTls: 9292, tls: 49292 });
  });

  it('path e encoding di protocollo', () => {
    expect(JSON_RPC_PATH).toBe('/api/homematic.cgi');
    expect(ENCODING_OUT).toBe('iso-8859-1');
    expect(ENCODING_IN).toBe('utf-8');
  });

  it('TIMEOUTS espone valori di default sensati', () => {
    expect(TIMEOUTS.rpc).toBe(60000);
    expect(TIMEOUTS.ping).toBe(10000);
  });

  it('interfaceId compone centralName-interface', () => {
    expect(interfaceId('MyCCU', Interface.HMIP_RF)).toBe('MyCCU-HmIP-RF');
  });
});
