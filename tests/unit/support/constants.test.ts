import { describe, it, expect } from 'vitest';
import {
  Interface,
  INTERFACE_PORTS,
  INTERFACE_REMOTE_PATH,
  JSON_RPC_PATH,
  ENCODING_OUT,
  ENCODING_IN,
  TIMEOUTS,
  interfaceId,
  Operations,
  isReadable,
  isWritable,
  hasEvents,
  Flag,
  isVisible,
  isService,
  ParameterType,
  ParamsetKey,
  RxMode,
  DeviceFirmwareState,
  ParameterStatus,
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

  it('INTERFACE_REMOTE_PATH mappa /groups solo per VirtualDevices', () => {
    expect(INTERFACE_REMOTE_PATH[Interface.VIRTUAL_DEVICES]).toBe('/groups');
    expect(INTERFACE_REMOTE_PATH[Interface.HMIP_RF]).toBeUndefined();
    expect(INTERFACE_REMOTE_PATH[Interface.BIDCOS_RF]).toBeUndefined();
    expect(INTERFACE_REMOTE_PATH[Interface.BIDCOS_WIRED]).toBeUndefined();
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

  describe('Operations bitmask + gating', () => {
    it('valori', () => {
      expect(Operations.NONE).toBe(0);
      expect(Operations.READ).toBe(1);
      expect(Operations.WRITE).toBe(2);
      expect(Operations.EVENT).toBe(4);
    });

    it('isReadable/isWritable/hasEvents leggono i bit', () => {
      const rw = Operations.READ | Operations.WRITE;
      expect(isReadable(rw)).toBe(true);
      expect(isWritable(rw)).toBe(true);
      expect(hasEvents(rw)).toBe(false);

      const re = Operations.READ | Operations.EVENT;
      expect(isReadable(re)).toBe(true);
      expect(isWritable(re)).toBe(false);
      expect(hasEvents(re)).toBe(true);

      expect(isReadable(Operations.NONE)).toBe(false);
      expect(isWritable(Operations.NONE)).toBe(false);
      expect(hasEvents(Operations.NONE)).toBe(false);
    });
  });

  describe('Flag bitmask + gating', () => {
    it('valori', () => {
      expect(Flag.VISIBLE).toBe(1);
      expect(Flag.INTERNAL).toBe(2);
      expect(Flag.TRANSFORM).toBe(4);
      expect(Flag.SERVICE).toBe(8);
      expect(Flag.STICKY).toBe(0x10);
    });

    it('isVisible/isService leggono i bit', () => {
      expect(isVisible(Flag.VISIBLE)).toBe(true);
      expect(isVisible(Flag.INTERNAL)).toBe(false);
      expect(isService(Flag.SERVICE | Flag.VISIBLE)).toBe(true);
      expect(isService(Flag.VISIBLE)).toBe(false);
    });
  });

  it('ParameterType string enum', () => {
    expect(ParameterType.ACTION).toBe('ACTION');
    expect(ParameterType.BOOL).toBe('BOOL');
    expect(ParameterType.ENUM).toBe('ENUM');
    expect(ParameterType.FLOAT).toBe('FLOAT');
    expect(ParameterType.INTEGER).toBe('INTEGER');
    expect(ParameterType.STRING).toBe('STRING');
    expect(ParameterType.DUMMY).toBe('DUMMY');
    expect(ParameterType.EMPTY).toBe('');
  });

  it('ParamsetKey string enum', () => {
    expect(ParamsetKey.MASTER).toBe('MASTER');
    expect(ParamsetKey.VALUES).toBe('VALUES');
    expect(ParamsetKey.LINK).toBe('LINK');
    expect(ParamsetKey.SERVICE).toBe('SERVICE');
    expect(ParamsetKey.CALCULATED).toBe('CALCULATED');
    expect(ParamsetKey.COMBINED).toBe('COMBINED');
    expect(ParamsetKey.DUMMY).toBe('DUMMY');
  });

  it('RxMode bitmask', () => {
    expect(RxMode.UNDEFINED).toBe(0);
    expect(RxMode.ALWAYS).toBe(1);
    expect(RxMode.BURST).toBe(2);
    expect(RxMode.CONFIG).toBe(4);
    expect(RxMode.WAKEUP).toBe(8);
    expect(RxMode.LAZY_CONFIG).toBe(16);
  });

  it('DeviceFirmwareState string enum', () => {
    expect(DeviceFirmwareState.UNKNOWN).toBe('UNKNOWN');
    expect(DeviceFirmwareState.UP_TO_DATE).toBe('UP_TO_DATE');
    expect(DeviceFirmwareState.NEW_FIRMWARE_AVAILABLE).toBe('NEW_FIRMWARE_AVAILABLE');
    expect(DeviceFirmwareState.READY_FOR_UPDATE).toBe('READY_FOR_UPDATE');
    expect(DeviceFirmwareState.PERFORMING_UPDATE).toBe('PERFORMING_UPDATE');
    expect(DeviceFirmwareState.BACKGROUND_UPDATE_NOT_SUPPORTED).toBe(
      'BACKGROUND_UPDATE_NOT_SUPPORTED',
    );
  });

  it('ParameterStatus string enum', () => {
    expect(ParameterStatus.NORMAL).toBe('NORMAL');
    expect(ParameterStatus.UNKNOWN).toBe('UNKNOWN');
    expect(ParameterStatus.OVERFLOW).toBe('OVERFLOW');
    expect(ParameterStatus.UNDERFLOW).toBe('UNDERFLOW');
    expect(ParameterStatus.ERROR).toBe('ERROR');
    expect(ParameterStatus.INVALID).toBe('INVALID');
    expect(ParameterStatus.UNUSED).toBe('UNUSED');
    expect(ParameterStatus.EXTERNAL).toBe('EXTERNAL');
  });
});
