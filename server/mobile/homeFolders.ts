// homeFolders.ts — which folders on this Mac a paired phone may browse and start a session in (AASC-54).
//
// Inside the home folder only, and never through a hidden folder (`.ssh`, `.config`, `.git`, any dot-folder)
// or a private one (secretPaths.ts: `~/Library`, keychains, agent config). Checked twice: on the path as
// written (so `~/proj/../.ssh` is refused before the disk is asked) and on its real path after links are
// followed (so `~/code/keys -> ~/.ssh` is still `~/.ssh`, and a link out of home leads nowhere).
//
// One module for the phone's launch rule (phoneProfile.ts) and the folder browser (folderRouter.ts), so the
// folders a phone is shown and the folders it may start in can't drift apart.

import { realpathSync, statSync } from 'fs';
import { opendir, realpath, stat } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { HOME_SECRET_SEGMENTS, segmentLooksSecret } from './secretPaths.js';

/** The most folders one listing returns; a phone scrolls a list, it doesn't page it. */
export const FOLDER_LIST_LIMIT = 500;

export function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

export function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** Does a path under the home folder pass through anything a phone may never read? */
export function touchesSecret(pathInHome: string): boolean {
  const segments = pathInHome.split(sep).filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length > 0 && HOME_SECRET_SEGMENTS.has(segments[0])) return true;
  return segments.some(segmentLooksSecret);
}

/** A hidden (dot) folder anywhere along it, or a private one. */
function hiddenOrSecret(pathInHome: string): boolean {
  return pathInHome.split(sep).some((s) => s.startsWith('.')) || touchesSecret(pathInHome);
}

/**
 * Why a folder can't be used:
 * - outside  not under the home folder, or through a hidden or private folder (as written or after links)
 * - missing  no folder there (nothing, or a file). Said only when the path as written passed AND its
 *            nearest existing folder is itself allowed, so a link into `~/.ssh` can't be used to ask
 *            whether a file exists there, and a file is never told from nothing.
 */
export type FolderRefusal = 'outside' | 'missing';
export type FolderCheck = { ok: true; path: string } | { ok: false; reason: FolderRefusal };

/** The path as written, when it is absolute (after `~`) and inside home without a hidden or private folder. */
export function writtenFolder(requested: string, home: string): string | null {
  const realHome = realOrNull(home);
  const expanded = expandHome(requested.trim() || '~', home);
  if (!realHome || !isAbsolute(expanded)) return null;
  const written = resolve(expanded);
  const writtenHome = [resolve(home), realHome].find((h) => inside(written, h));
  return writtenHome && !hiddenOrSecret(relative(writtenHome, written)) ? written : null;
}

/** Is this real path inside the real home folder, clear of hidden and private folders? */
function realAllowed(real: string, realHome: string): boolean {
  return inside(real, realHome) && !hiddenOrSecret(relative(realHome, real));
}

/** Nothing usable at `written`: missing, unless the nearest folder that does exist leads somewhere refused. */
function missingOrOutside(written: string, realHome: string): FolderCheck {
  for (let at = dirname(written); ; at = dirname(at)) {
    const real = realOrNull(at);
    if (real) return { ok: false, reason: realAllowed(real, realHome) ? 'missing' : 'outside' };
    if (at === dirname(at)) return { ok: false, reason: 'outside' };
  }
}

/**
 * The real folder `requested` names (absolute or `~/…`; empty means the home folder) when a phone may
 * browse it: the home folder itself, or a folder in it reached without a hidden or private folder.
 */
export function browsableFolder(requested: string, home: string): FolderCheck {
  const realHome = realOrNull(home);
  const written = writtenFolder(requested, home);
  if (!realHome || !written) return { ok: false, reason: 'outside' };
  const real = realOrNull(written);
  if (!real) return missingOrOutside(written, realHome);
  if (!realAllowed(real, realHome)) return { ok: false, reason: 'outside' };
  let isDir = false;
  try {
    isDir = statSync(real).isDirectory();
  } catch { /* gone since */ }
  return isDir ? { ok: true, path: real } : missingOrOutside(written, realHome);
}

export interface FolderEntry {
  name: string;
  /** Its path as listed (a link keeps its own name); the launch rule resolves it again. */
  path: string;
}

export interface FolderListing {
  /** The real folder listed. */
  path: string;
  /** The real home folder (the browser's first breadcrumb). */
  home: string;
  /** The folder above, or null at the home folder. */
  parent: string | null;
  folders: FolderEntry[];
  /** More folders than `limit` were there, or the folder was too big to read to the end. */
  truncated: boolean;
}

/** The most entries one listing reads: a folder with more (node_modules, a photo dump) is cut short. */
export const FOLDER_SCAN_LIMIT = 5000;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** One entry of a listing, checked like the folder itself but off the event loop. */
async function entryAllowed(path: string, realHome: string): Promise<boolean> {
  try {
    const real = await realpath(path);
    return realAllowed(real, realHome) && (await stat(real)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folders in `requested`, by name: names and paths only — no files, no hidden or private folders, no
 * link that leads out of home or into one. Null when the folder itself may not be browsed. Reads at most
 * `FOLDER_SCAN_LIMIT` entries, asynchronously, so a huge or slow folder can't stall the server.
 */
export async function listFolders(requested: string, home: string, limit = FOLDER_LIST_LIMIT): Promise<FolderListing | null> {
  const check = browsableFolder(requested, home);
  const realHome = realOrNull(home);
  if (!check.ok || !realHome) return null;
  const names: string[] = [];
  let scanned = 0;
  let cut = false;
  try {
    const dir = await opendir(check.path);
    for await (const e of dir) {
      if (++scanned > FOLDER_SCAN_LIMIT) {
        cut = true;
        break; // leaving the loop closes the handle
      }
      if (!e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())) names.push(e.name);
    }
  } catch {
    // unreadable (permissions): what was read so far, usually nothing
  }
  names.sort(byName.compare);
  const folders: FolderEntry[] = [];
  for (const name of names) {
    if (folders.length > limit) break; // one past the limit is enough to say "truncated"
    const path = join(check.path, name);
    if (await entryAllowed(path, realHome)) folders.push({ name, path });
  }
  return {
    path: check.path,
    home: realHome,
    parent: check.path === realHome ? null : dirname(check.path),
    folders: folders.slice(0, limit),
    truncated: cut || folders.length > limit,
  };
}
