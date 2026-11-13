// ownerToken.ts — the owner's key to this server, as a file only the owner can read (D7, §8.2).
//
// With a password set, every request needs a token, loopback included. The admin CLI on the box
// (`aasc-server pair`, `devices`, `status`) and `aasc --ssh` prove ownership by reading
// <data>/owner.token: 32 random bytes, hex, mode 0600, in the 0700 data folder.
//
//   · New at every start, so a copied token dies with the process that wrote it.
//   · Accepted only beside isLocalRequest (authManager.ts isOwnerRequest), never on its own: through
//     the remote-only listener, with a forwarding header or from another address it is just a
//     wrong token.
//   · Never logged, and never in argv or the environment: the file is the only way it travels.
//
// Only aasc-server (AASC_HEADLESS=1) writes one by default; the desktop app and dev servers opt in
// with AASC_OWNER_TOKEN=1 or "ownerToken": true (what `aasc --ssh` needs). A key nobody uses is
// only something to steal. AASC_OWNER_TOKEN=0 turns it off everywhere.
//
// The file is written to a temporary name created O_EXCL|O_NOFOLLOW and renamed over the path, so a
// symlink planted at owner.token is replaced, never written through.

import { closeSync, constants, fchmodSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs';
import { join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { isHeadless } from './edition.js';

export const OWNER_TOKEN_FILE = 'owner.token';
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** The token this process accepts; null until writeOwnerToken runs. */
let current: Buffer | null = null;

export function ownerTokenPath(dataDir: string): string {
  return join(dataDir, OWNER_TOKEN_FILE);
}

/** Should this start write owner.token? The env var wins over server-config.json's `ownerToken`. */
export function ownerTokenWanted(env: NodeJS.ProcessEnv, config: { ownerToken?: unknown }): boolean {
  if (env.AASC_OWNER_TOKEN === '0') return false;
  if (env.AASC_OWNER_TOKEN === '1') return true;
  return isHeadless(env) || config.ownerToken === true;
}

/**
 * A server that writes no token removes one a crashed earlier start left behind, so `aasc --ssh`
 * says how to turn it on instead of presenting a dead key. Safe: the folder lock is held.
 */
export function discardOwnerToken(dataDir: string): void {
  try { unlinkSync(ownerTokenPath(dataDir)); } catch { /* none there */ }
}

/** Make a new token, write it to <dataDir>/owner.token (0600) and accept only it from now on. */
export function writeOwnerToken(dataDir: string): void {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const path = ownerTokenPath(dataDir);
  const temp = join(dataDir, `.${OWNER_TOKEN_FILE}.${randomBytes(6).toString('hex')}`);
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    // The mode passed to open is masked by the umask; this is the mode the file must have.
    fchmodSync(fd, 0o600);
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw err;
  }
  current = Buffer.from(token, 'utf8');
}

/** Timing-safe: is this the token this process wrote? */
export function isOwnerToken(token: string | null | undefined): boolean {
  if (!current || typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  const given = Buffer.from(token, 'utf8');
  return given.length === current.length && timingSafeEqual(given, current);
}

/** At exit: remove the file while it still holds this process's token, then accept nothing. */
export function removeOwnerToken(dataDir: string): void {
  const mine = current;
  current = null;
  if (!mine) return;
  const path = ownerTokenPath(dataDir);
  try {
    if (readFileSync(path, 'utf8').trim() === mine.toString('utf8')) unlinkSync(path);
  } catch {
    /* already gone, or unreadable: nothing of ours to remove */
  }
}
