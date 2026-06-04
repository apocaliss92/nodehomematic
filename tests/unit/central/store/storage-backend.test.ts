import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryStorageBackend,
  FileStorageBackend,
  slug,
} from '../../../../src/central/store/storage-backend.js';

describe('central/store/slug', () => {
  it('lowercases and replaces non-alphanumeric with underscore', () => {
    expect(slug('My CCU!')).toBe('my_ccu_');
    expect(slug('Ccu-3.RaspberryMatic')).toBe('ccu_3_raspberrymatic');
    expect(slug('abc123')).toBe('abc123');
  });
});

describe('central/store/InMemoryStorageBackend', () => {
  it('save then load returns the content', async () => {
    const backend = new InMemoryStorageBackend();
    expect(await backend.load('devices')).toBeNull();
    await backend.save('devices', '{"a":1}');
    expect(await backend.load('devices')).toBe('{"a":1}');
  });

  it('remove deletes the entry', async () => {
    const backend = new InMemoryStorageBackend();
    await backend.save('devices', 'x');
    await backend.remove('devices');
    expect(await backend.load('devices')).toBeNull();
  });
});

describe('central/store/FileStorageBackend', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nhm-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save writes a slugged file and load reads it back', async () => {
    const backend = new FileStorageBackend({ dir, centralName: 'My CCU' });
    await backend.save('devices', '{"k":1}');
    const onDisk = await readFile(join(dir, 'my_ccu_devices.json'), 'utf-8');
    expect(onDisk).toBe('{"k":1}');
    expect(await backend.load('devices')).toBe('{"k":1}');
  });

  it('load returns null when the file is missing', async () => {
    const backend = new FileStorageBackend({ dir, centralName: 'ccu' });
    expect(await backend.load('missing')).toBeNull();
  });

  it('creates the directory if it does not exist', async () => {
    const nested = join(dir, 'a', 'b');
    const backend = new FileStorageBackend({ dir: nested, centralName: 'ccu' });
    await backend.save('devices', 'data');
    expect(await backend.load('devices')).toBe('data');
  });

  it('remove deletes the file and is idempotent', async () => {
    const backend = new FileStorageBackend({ dir, centralName: 'ccu' });
    await backend.save('devices', 'data');
    await backend.remove('devices');
    expect(await backend.load('devices')).toBeNull();
    await expect(backend.remove('devices')).resolves.toBeUndefined();
  });

  it('works when the directory already exists', async () => {
    await mkdir(join(dir, 'exists'), { recursive: true });
    const backend = new FileStorageBackend({ dir: join(dir, 'exists'), centralName: 'ccu' });
    await backend.save('x', 'y');
    expect(await backend.load('x')).toBe('y');
  });
});
