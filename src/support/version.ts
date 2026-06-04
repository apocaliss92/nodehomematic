export const LIBRARY_NAME = 'nodehomematic' as const;

const MIN_MAJOR = 20;

/**
 * @internal
 * Internal helper used during bootstrap to validate the running Node.js version.
 * Not part of the public API surface; the public facade lands in Phase 3 and is
 * deliberately not re-exported from `src/index.ts`.
 */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\./.exec(version);
  if (match?.[1] === undefined) return false;
  const major = Number.parseInt(match[1], 10);
  return !Number.isNaN(major) && major >= MIN_MAJOR;
}
