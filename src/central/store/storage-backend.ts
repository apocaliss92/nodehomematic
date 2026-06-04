/**
 * Pluggable persistence backend for the central's caches.
 *
 * The central never touches the filesystem directly; it persists named blobs
 * through a {@link StorageBackend}. Tests inject {@link InMemoryStorageBackend}
 * so they stay fast and hermetic; production uses {@link FileStorageBackend}.
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Persistence contract for named JSON blobs. */
export interface StorageBackend {
  /** Load a blob by logical name, or `null` if it does not exist. */
  load(name: string): Promise<string | null>;
  /** Persist a blob under a logical name (overwrites). */
  save(name: string, content: string): Promise<void>;
  /** Remove a blob by name; a no-op if it is already absent. */
  remove(name: string): Promise<void>;
}

/**
 * Normalise an arbitrary string into a filesystem-safe slug: lowercased with
 * every run of non-alphanumeric characters collapsed to a single underscore.
 */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/** Constructor options for {@link FileStorageBackend}. */
export interface FileStorageBackendOptions {
  /** Directory where cache files live; created on first write. */
  readonly dir: string;
  /** Central name; slugged into each filename to namespace by central. */
  readonly centralName: string;
}

/**
 * File-backed storage. Files are written as `${slug(centralName)}_${name}.json`
 * inside the configured directory, which is created on demand.
 */
export class FileStorageBackend implements StorageBackend {
  private readonly dir: string;
  private readonly prefix: string;

  public constructor(options: FileStorageBackendOptions) {
    this.dir = options.dir;
    this.prefix = slug(options.centralName);
  }

  private fileFor(name: string): string {
    return join(this.dir, `${this.prefix}_${name}.json`);
  }

  public async load(name: string): Promise<string | null> {
    try {
      return await readFile(this.fileFor(name), 'utf-8');
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  public async save(name: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileFor(name), content, 'utf-8');
  }

  public async remove(name: string): Promise<void> {
    await rm(this.fileFor(name), { force: true });
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** In-memory storage backed by a `Map`; intended for tests. */
export class InMemoryStorageBackend implements StorageBackend {
  private readonly store = new Map<string, string>();

  public load(name: string): Promise<string | null> {
    return Promise.resolve(this.store.get(name) ?? null);
  }

  public save(name: string, content: string): Promise<void> {
    this.store.set(name, content);
    return Promise.resolve();
  }

  public remove(name: string): Promise<void> {
    this.store.delete(name);
    return Promise.resolve();
  }
}
