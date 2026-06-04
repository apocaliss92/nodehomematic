import { describe, it, expect } from 'vitest';
import {
  makeDpk,
  dpkToUniqueId,
  uniqueIdToDpk,
  type DataPointKey,
} from '../../../src/support/dpk.js';

describe('support/dpk', () => {
  it('makeDpk creates a DataPointKey with the given fields', () => {
    const dpk = makeDpk('MyCCU-HmIP-RF', 'VCU0000001:1', 'VALUES', 'STATE');
    expect(dpk).toEqual<DataPointKey>({
      interfaceId: 'MyCCU-HmIP-RF',
      channelAddress: 'VCU0000001:1',
      paramsetKey: 'VALUES',
      parameter: 'STATE',
    });
  });

  it('dpkToUniqueId produces a lowercase string', () => {
    const dpk = makeDpk('MyCCU-HmIP-RF', 'VCU0000001:1', 'VALUES', 'STATE');
    expect(dpkToUniqueId(dpk)).toBe('myccu-hmip-rf:vcu0000001:1:values:state');
  });

  it('round-trip with a channelAddress containing a colon', () => {
    const dpk = makeDpk('iface-1', 'VCU0000001:1', 'VALUES', 'LEVEL');
    const id = dpkToUniqueId(dpk);
    const parsed = uniqueIdToDpk(id);
    expect(parsed).toEqual<DataPointKey>({
      interfaceId: 'iface-1',
      channelAddress: 'vcu0000001:1',
      paramsetKey: 'values',
      parameter: 'level',
    });
  });

  it('round-trip with a channelAddress without a colon (device-level)', () => {
    const dpk = makeDpk('iface-1', 'ABC123', 'MASTER', 'AES_ACTIVE');
    const parsed = uniqueIdToDpk(dpkToUniqueId(dpk));
    expect(parsed).toEqual<DataPointKey>({
      interfaceId: 'iface-1',
      channelAddress: 'abc123',
      paramsetKey: 'master',
      parameter: 'aes_active',
    });
  });

  it('uniqueIdToDpk is exactly the inverse of dpkToUniqueId (lowercased)', () => {
    const ids = [
      'iface-1:vcu0000001:1:values:state',
      'iface-2:abc123:master:aes_active',
      'a:b:1:c:d', // channelAddress with colon = "b:1"
    ];
    for (const id of ids) {
      expect(dpkToUniqueId(uniqueIdToDpk(id))).toBe(id);
    }
  });
});
