import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceProfileRegistry } from '../../../../src/model/custom/registry.js';
import { DeviceProfile } from '../../../../src/model/custom/profile.js';
import { CustomEntity } from '../../../../src/model/custom/base.js';

class StubEntity extends CustomEntity {
  public readonly kind = 'stub';
}

const config = (profile: DeviceProfile, channels: number[]) => ({
  entityClass: StubEntity,
  profile,
  channels,
});

describe('DeviceProfileRegistry', () => {
  let registry: DeviceProfileRegistry;

  beforeEach(() => {
    registry = new DeviceProfileRegistry();
  });

  it('returns [] for an unknown model', () => {
    expect(registry.getConfigs('HmIP-NOPE')).toEqual([]);
  });

  it('matches an exact normalised model', () => {
    registry.register('HmIP-PS', config(DeviceProfile.IP_SWITCH, [3]));
    const configs = registry.getConfigs('HmIP-PS');
    expect(configs).toHaveLength(1);
    expect(configs[0]?.profile).toBe(DeviceProfile.IP_SWITCH);
    expect(configs[0]?.channels).toEqual([3]);
  });

  it('matches by prefix when no exact match exists', () => {
    registry.register('hmip-ps', config(DeviceProfile.IP_SWITCH, [3]));
    expect(registry.getConfigs('HmIP-PS')).toHaveLength(1);
    expect(registry.getConfigs('HmIP-PSM')).toHaveLength(1);
    expect(registry.getConfigs('HmIP-PSM')[0]?.channels).toEqual([3]);
  });

  it('prefers an exact match over a prefix match', () => {
    registry.register('hmip-ps', config(DeviceProfile.IP_SWITCH, [3]));
    registry.register('hmip-psm', config(DeviceProfile.RF_SWITCH, [9]));
    const configs = registry.getConfigs('HmIP-PSM');
    expect(configs).toHaveLength(1);
    expect(configs[0]?.profile).toBe(DeviceProfile.RF_SWITCH);
  });

  it('normalises the hb- vendor prefix to hm-', () => {
    registry.register('HM-LC-Sw1', config(DeviceProfile.RF_SWITCH, [1]));
    expect(registry.getConfigs('HB-LC-Sw1-Pl')).toHaveLength(1);
  });

  it('registerMultiple aggregates configs under one model', () => {
    registry.registerMultiple('HmIP-DLD', [
      config(DeviceProfile.IP_LOCK, [1]),
      config(DeviceProfile.IP_SWITCH, [2]),
    ]);
    expect(registry.getConfigs('HmIP-DLD')).toHaveLength(2);
  });

  it('aggregates across repeated registrations of the same model', () => {
    registry.register('HmIP-DLD', config(DeviceProfile.IP_LOCK, [1]));
    registry.register('HmIP-DLD', config(DeviceProfile.IP_SWITCH, [2]));
    expect(registry.getConfigs('HmIP-DLD')).toHaveLength(2);
  });
});
