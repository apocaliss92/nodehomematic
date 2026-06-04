export const LIBRARY_NAME = 'nodehomematic' as const;

const MIN_MAJOR = 20;

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\./.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  return Number.isInteger(major) && major >= MIN_MAJOR;
}
