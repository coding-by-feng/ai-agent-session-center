/**
 * Project Sync servers and paths: what a typed server or server folder may be, and how this
 * computer's file system folds names. Pure checks, plus one read-only probe of the disk.
 */
import { lstat } from 'fs/promises';
import { basename, dirname, join, posix } from 'path';
import type { SyncDeviceInput } from '../../src/types/projectSync.js';

export const MAX_DEVICES = 20;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/;

/** Why a server as typed can't be used, or null. Nothing may read as an ssh option. */
export function invalidDeviceInput(d: SyncDeviceInput): string | null {
  if (!d.name.trim() || d.name.length > 64) return 'Give the server a short name.';
  if (!HOST_RE.test(d.host) || d.host.includes('..')) return 'Use a host name or IPv4 address.';
  if (!USER_RE.test(d.username)) return 'Use a plain user name.';
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535)
    return 'Use a port from 1 to 65535.';
  return null;
}

/** Why a folder on the server can't be a link's root, or null. */
export function validRemoteRoot(root: string, deviceHome: string): string | null {
  if (!posix.isAbsolute(root) || /[\x00-\x1f]/.test(root) || root.length > 4096)
    return 'Use an absolute folder path.';
  if (posix.normalize(root) !== root || root.endsWith('/'))
    return 'Use a plain path without "..", "//" or a trailing slash.';
  if (root === deviceHome) return 'The server folder cannot be the home folder itself.';
  if (!root.startsWith(deviceHome + '/')) return `The server folder must be inside ${deviceHome}.`;
  if (
    root
      .split('/')
      .some((seg) => ['.ssh', '.gnupg', '.aws', '.kube', '.aasc-project-sync'].includes(seg))
  )
    return 'That folder holds credentials or AASC state; choose a project folder.';
  return null;
}

const macFold = (p: string) => p.normalize('NFC').toLowerCase();

/**
 * Whether the file system under `root` folds names (APFS and HFS+ by default: letter case and
 * Unicode normalization). Measured on the nearest name with letters, so nothing is written.
 */
export async function measureFold(root: string): Promise<((path: string) => string) | undefined> {
  let dir = root;
  for (let i = 0; i < 64; i++) {
    const name = basename(dir);
    const swapped = [...name]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join('');
    if (swapped !== name) {
      try {
        const [a, b] = await Promise.all([lstat(dir), lstat(join(dirname(dir), swapped))]);
        if (a.ino === b.ino && a.dev === b.dev) return macFold;
      } catch {
        /* the other spelling does not exist: names are kept apart */
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.platform === 'darwin' ? macFold : undefined;
}
