import { describe, it, expect, vi } from 'vitest';
import {
  DeviceDescriptionCache,
  ParamsetDescriptionCache,
} from '../../../../src/central/store/description-cache.js';
import {
  InMemoryStorageBackend,
  type StorageBackend,
} from '../../../../src/central/store/storage-backend.js';
import type { DeviceDescription, ParameterData } from '../../../../src/transport/xmlrpc/types.js';

const IFACE = 'ccu-HmIP-RF';

function device(address: string, type = 'HmIP-XYZ'): DeviceDescription {
  return { ADDRESS: address, TYPE: type, PARAMSETS: ['VALUES'] };
}

function param(operations: number): ParameterData {
  return { TYPE: 'BOOL', OPERATIONS: operations, FLAGS: 1 };
}

/** A backend that counts saves, wrapping an in-memory store. */
function countingBackend(): { backend: StorageBackend; saves: () => number } {
  const inner = new InMemoryStorageBackend();
  const saveSpy = vi.fn(async (name: string, content: string) => inner.save(name, content));
  const backend: StorageBackend = {
    load: (name) => inner.load(name),
    save: saveSpy,
    remove: (name) => inner.remove(name),
  };
  return { backend, saves: () => saveSpy.mock.calls.length };
}

describe('central/store/DeviceDescriptionCache', () => {
  it('add/get/getAll/getAllInterfaces', () => {
    const cache = new DeviceDescriptionCache(new InMemoryStorageBackend(), 'devices');
    cache.add(IFACE, device('VCU1'));
    cache.add(IFACE, device('VCU1:1', 'CHANNEL'));
    expect(cache.get(IFACE, 'VCU1')?.ADDRESS).toBe('VCU1');
    expect(cache.getAll(IFACE)).toHaveLength(2);
    expect(cache.getAllInterfaces()).toEqual([IFACE]);
    expect(cache.get('other', 'VCU1')).toBeUndefined();
  });

  it('round-trips save then load identically', async () => {
    const backend = new InMemoryStorageBackend();
    const a = new DeviceDescriptionCache(backend, 'devices');
    a.add(IFACE, device('VCU1'));
    a.add(IFACE, device('VCU1:1', 'CHANNEL'));
    await a.saveAll();

    const b = new DeviceDescriptionCache(backend, 'devices');
    expect(await b.load()).toBe('loaded');
    expect(b.get(IFACE, 'VCU1')).toEqual(device('VCU1'));
    expect(b.get(IFACE, 'VCU1:1')).toEqual(device('VCU1:1', 'CHANNEL'));
  });

  it('load returns empty when nothing stored', async () => {
    const cache = new DeviceDescriptionCache(new InMemoryStorageBackend(), 'devices');
    expect(await cache.load()).toBe('empty');
    expect(cache.getAllInterfaces()).toEqual([]);
  });

  it('load returns version-mismatch and stays empty', async () => {
    const backend = new InMemoryStorageBackend();
    await backend.save(
      'devices',
      JSON.stringify({ schemaVersion: 999, data: { [IFACE]: { VCU1: device('VCU1') } } }),
    );
    const cache = new DeviceDescriptionCache(backend, 'devices');
    expect(await cache.load()).toBe('version-mismatch');
    expect(cache.getAllInterfaces()).toEqual([]);
  });

  it('load returns fail on unparseable content and stays empty', async () => {
    const backend = new InMemoryStorageBackend();
    await backend.save('devices', 'not-json{');
    const cache = new DeviceDescriptionCache(backend, 'devices');
    expect(await cache.load()).toBe('fail');
    expect(cache.getAllInterfaces()).toEqual([]);
  });

  it('removeDevice removes the device and its channel addresses', () => {
    const cache = new DeviceDescriptionCache(new InMemoryStorageBackend(), 'devices');
    cache.add(IFACE, device('VCU1'));
    cache.add(IFACE, device('VCU1:1', 'CHANNEL'));
    cache.add(IFACE, device('VCU1:2', 'CHANNEL'));
    cache.add(IFACE, device('VCU2'));
    cache.removeDevice(IFACE, 'VCU1');
    expect(cache.get(IFACE, 'VCU1')).toBeUndefined();
    expect(cache.get(IFACE, 'VCU1:1')).toBeUndefined();
    expect(cache.get(IFACE, 'VCU1:2')).toBeUndefined();
    expect(cache.get(IFACE, 'VCU2')?.ADDRESS).toBe('VCU2');
  });

  it('saveIfChanged saves only when content hash changed', async () => {
    const { backend, saves } = countingBackend();
    const cache = new DeviceDescriptionCache(backend, 'devices');
    cache.add(IFACE, device('VCU1'));
    await cache.saveIfChanged();
    expect(saves()).toBe(1);
    await cache.saveIfChanged();
    expect(saves()).toBe(1);
    cache.add(IFACE, device('VCU2'));
    await cache.saveIfChanged();
    expect(saves()).toBe(2);
  });

  it('contentHash is deterministic regardless of insertion order', () => {
    const a = new DeviceDescriptionCache(new InMemoryStorageBackend(), 'devices');
    a.add(IFACE, device('VCU1'));
    a.add(IFACE, device('VCU2'));
    const b = new DeviceDescriptionCache(new InMemoryStorageBackend(), 'devices');
    b.add(IFACE, device('VCU2'));
    b.add(IFACE, device('VCU1'));
    expect(a.contentHash()).toBe(b.contentHash());
  });

  it('hasUnsavedChanges tracks save state', async () => {
    const cache = new DeviceDescriptionCache(new InMemoryStorageBackend(), 'devices');
    expect(cache.hasUnsavedChanges).toBe(false);
    cache.add(IFACE, device('VCU1'));
    expect(cache.hasUnsavedChanges).toBe(true);
    await cache.saveAll();
    expect(cache.hasUnsavedChanges).toBe(false);
  });
});

describe('central/store/ParamsetDescriptionCache', () => {
  it('add/getParamset/getParamsetKeys', () => {
    const cache = new ParamsetDescriptionCache(new InMemoryStorageBackend(), 'paramsets');
    cache.add(IFACE, 'VCU1:1', 'VALUES', 'STATE', param(7));
    cache.add(IFACE, 'VCU1:1', 'MASTER', 'CFG', param(3));
    expect(cache.getParamset(IFACE, 'VCU1:1', 'VALUES')).toEqual({ STATE: param(7) });
    expect(cache.getParamsetKeys(IFACE, 'VCU1:1').sort()).toEqual(['MASTER', 'VALUES']);
    expect(cache.getParamset(IFACE, 'VCU1:1', 'LINK')).toBeUndefined();
  });

  it('addParamset adds a whole record at once', () => {
    const cache = new ParamsetDescriptionCache(new InMemoryStorageBackend(), 'paramsets');
    cache.addParamset(IFACE, 'VCU1:1', 'VALUES', { STATE: param(7), LEVEL: param(7) });
    expect(Object.keys(cache.getParamset(IFACE, 'VCU1:1', 'VALUES') ?? {}).sort()).toEqual([
      'LEVEL',
      'STATE',
    ]);
  });

  it('round-trips save then load identically', async () => {
    const backend = new InMemoryStorageBackend();
    const a = new ParamsetDescriptionCache(backend, 'paramsets');
    a.add(IFACE, 'VCU1:1', 'VALUES', 'STATE', param(7));
    await a.saveAll();
    const b = new ParamsetDescriptionCache(backend, 'paramsets');
    expect(await b.load()).toBe('loaded');
    expect(b.getParamset(IFACE, 'VCU1:1', 'VALUES')).toEqual({ STATE: param(7) });
  });

  it('load returns version-mismatch and stays empty', async () => {
    const backend = new InMemoryStorageBackend();
    await backend.save('paramsets', JSON.stringify({ schemaVersion: 999, data: {} }));
    const cache = new ParamsetDescriptionCache(backend, 'paramsets');
    expect(await cache.load()).toBe('version-mismatch');
    expect(cache.getParamsetKeys(IFACE, 'VCU1:1')).toEqual([]);
  });

  it('load returns fail on unparseable content', async () => {
    const backend = new InMemoryStorageBackend();
    await backend.save('paramsets', '}{bad');
    const cache = new ParamsetDescriptionCache(backend, 'paramsets');
    expect(await cache.load()).toBe('fail');
  });

  it('removeDevice removes channel === address and address:* channels', () => {
    const cache = new ParamsetDescriptionCache(new InMemoryStorageBackend(), 'paramsets');
    cache.add(IFACE, 'VCU1', 'MASTER', 'CFG', param(3));
    cache.add(IFACE, 'VCU1:1', 'VALUES', 'STATE', param(7));
    cache.add(IFACE, 'VCU1:2', 'VALUES', 'STATE', param(7));
    cache.add(IFACE, 'VCU2:1', 'VALUES', 'STATE', param(7));
    cache.removeDevice(IFACE, 'VCU1');
    expect(cache.getParamsetKeys(IFACE, 'VCU1')).toEqual([]);
    expect(cache.getParamsetKeys(IFACE, 'VCU1:1')).toEqual([]);
    expect(cache.getParamsetKeys(IFACE, 'VCU1:2')).toEqual([]);
    expect(cache.getParamsetKeys(IFACE, 'VCU2:1')).toEqual(['VALUES']);
  });

  it('saveIfChanged saves only when content hash changed', async () => {
    const { backend, saves } = countingBackend();
    const cache = new ParamsetDescriptionCache(backend, 'paramsets');
    cache.add(IFACE, 'VCU1:1', 'VALUES', 'STATE', param(7));
    await cache.saveIfChanged();
    expect(saves()).toBe(1);
    await cache.saveIfChanged();
    expect(saves()).toBe(1);
    cache.add(IFACE, 'VCU1:1', 'VALUES', 'LEVEL', param(7));
    await cache.saveIfChanged();
    expect(saves()).toBe(2);
  });

  it('contentHash is deterministic regardless of insertion order', () => {
    const a = new ParamsetDescriptionCache(new InMemoryStorageBackend(), 'paramsets');
    a.add(IFACE, 'VCU1:1', 'VALUES', 'STATE', param(7));
    a.add(IFACE, 'VCU1:1', 'VALUES', 'LEVEL', param(7));
    const b = new ParamsetDescriptionCache(new InMemoryStorageBackend(), 'paramsets');
    b.add(IFACE, 'VCU1:1', 'VALUES', 'LEVEL', param(7));
    b.add(IFACE, 'VCU1:1', 'VALUES', 'STATE', param(7));
    expect(a.contentHash()).toBe(b.contentHash());
  });
});
