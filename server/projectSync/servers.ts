/**
 * Project Sync servers and paths: what a typed server or server folder may be, and how this
 * computer's file system folds names. Pure checks, plus one read-only probe of the disk.
 */
import { randomUUID } from 'crypto';
import { lstat } from 'fs/promises';
import { basename, dirname, join, posix } from 'path';
import { clean, SyncError } from './errors.js';
import type { SyncDevice, SyncDeviceInput } from '../../src/types/projectSync.js';

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

/**
 * A server as typed, checked before it is saved: a plain address not already saved, a trusted
 * host key (pinned by digest), and a reachable macOS or Linux helper with Node.js 18+.
 */
export async function checkNewDevice(
  input: SyncDeviceInput,
  deps: {
    saved: SyncDevice[];
    fingerprint: (d: SyncDeviceInput) => Promise<string>;
    probe: (
      d: SyncDeviceInput & { fingerprint: string },
    ) => Promise<{ home: string; platform: string; node: string }>;
  },
): Promise<SyncDevice> {
  const d: SyncDeviceInput = {
    name: input.name.trim(),
    host: input.host.trim(),
    username: input.username.trim(),
    port: input.port,
  };
  const bad = invalidDeviceInput(d);
  if (bad) throw new SyncError(bad, 400);
  if (deps.saved.length >= MAX_DEVICES)
    throw new SyncError('Remove a server before adding another.');
  if (deps.saved.some((x) => x.host === d.host && x.username === d.username && x.port === d.port))
    throw new SyncError('That server is already added.');
  let pinned: string;
  try {
    pinned = await deps.fingerprint(d);
  } catch (e) {
    throw new SyncError(clean(e));
  }
  let info: { home: string; platform: string; node: string };
  try {
    info = await deps.probe({ ...d, fingerprint: pinned });
  } catch (e) {
    throw new SyncError(`Could not reach the server: ${clean(e)}`);
  }
  if (info.platform === 'win32') throw new SyncError('Windows servers are not supported.');
  if (!(Number(info.node.split('.')[0]) >= 18))
    throw new SyncError(`The server needs Node.js 18 or newer (it has ${info.node}).`);
  if (!posix.isAbsolute(info.home) || info.home === '/')
    throw new SyncError('The server reported no usable home folder.');
  return {
    id: randomUUID(),
    ...d,
    fingerprint: pinned,
    home: info.home,
    platform: info.platform,
    checkedAt: Date.now(),
  };
}

/**
 * A name as a Mac's file system reads it: Unicode forms and the characters HFS+ ignores fold away,
 * and letter case does not count. A guard compares names through this, or `.SSH` gets past `.ssh`
 * on a Mac server (the helper's `gitFold` is the same rule).
 */
const IGNORABLE_RE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
export const guardFold = (name: string) =>
  name.normalize('NFKC').replace(IGNORABLE_RE, '').toUpperCase().toLowerCase();
/** Folders never browsed, linked or pulled: credentials and AASC's own sync journal. */
export const PRIVATE_NAMES: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.aasc-project-sync',
];
export const isPrivateName = (name: string) => PRIVATE_NAMES.includes(guardFold(name));
export const isGitName = (name: string) => guardFold(name) === '.git';

/** Why a folder on the server can't be a link's root, or null. */
export function validRemoteRoot(root: string, deviceHome: string): string | null {
  if (!posix.isAbsolute(root) || /[\x00-\x1f]/.test(root) || root.length > 4096)
    return 'Use an absolute folder path.';
  if (posix.normalize(root) !== root || root.endsWith('/'))
    return 'Use a plain path without "..", "//" or a trailing slash.';
  if (root === deviceHome) return 'The server folder cannot be the home folder itself.';
  if (!root.startsWith(deviceHome + '/')) return `The server folder must be inside ${deviceHome}.`;
  const segs = root.slice(deviceHome.length + 1).split('/');
  if (segs.some(isPrivateName))
    return 'That folder holds credentials or AASC state; choose a project folder.';
  if (segs.some(isGitName))
    return 'A folder inside .git holds git’s own files; choose a project folder.';
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
