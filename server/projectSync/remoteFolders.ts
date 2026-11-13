/**
 * Project Sync reaching past a link (Nov 13 2026): the server folder picker, the free-space check
 * a run makes first, and the purge of undo journals for runs AASC no longer keeps.
 */
import { posix } from 'path';
import log from '../logger.js';
import { clean, SyncError } from './errors.js';
import { freeSpace, listDir, purgeRuns, type Launcher } from './helperClient.js';
import type { RemoteDirEntry, RemoteListing } from '../../src/types/projectSync.js';

/** Room a run leaves free beyond what it writes: backups and the journal live on the same disk. */
export const SPACE_MARGIN = 64 * 1048576;

const byFoldersFirst = (a: RemoteDirEntry, b: RemoteDirEntry) =>
  (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name);

/** One level of a server folder inside `home` (default: home itself), folders first. */
export async function browseFolder(
  launch: Launcher,
  home: string,
  path: string = home,
): Promise<RemoteListing> {
  let r: Awaited<ReturnType<typeof listDir>>;
  try {
    r = await listDir(launch, path);
  } catch (e) {
    throw new SyncError(clean(e));
  }
  if (r.missing) throw new SyncError('That folder does not exist on the server.', 404);
  return {
    path,
    home,
    parent: path === home ? null : posix.dirname(path),
    entries: r.entries.map((e) => ({ ...e, path: posix.join(path, e.name) })).sort(byFoldersFirst),
    truncated: r.truncated,
  };
}

const size = (n: number) =>
  n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.ceil(n / 1048576)} MB`;

/**
 * Refuses (409 `no-space`) when `where` has less room than `bytes` plus the margin. A side that
 * cannot tell its free space is not refused: the helper still fails cleanly on a full disk.
 */
export async function ensureRoom(
  spaceOf: (launch: Launcher, path: string) => Promise<number | null>,
  launch: Launcher,
  path: string,
  bytes: number,
  where: 'the server' | 'this computer',
): Promise<void> {
  if (bytes <= 0) return;
  let free: number | null;
  try {
    free = await spaceOf(launch, path);
  } catch {
    free = null;
  }
  if (free !== null && free < bytes + SPACE_MARGIN)
    throw new SyncError(
      `Not enough free space on ${where}: this run writes ${size(bytes)} there and ${size(free)} is free. Free some space, then sync again.`,
      409,
      'no-space',
    );
}

export const defaultSpaceOf = freeSpace;

/**
 * Removes the undo journals of `linkId`'s runs not in `keep`, on each side given. Best effort: a
 * side that cannot be reached keeps its journals until the next purge.
 */
export async function purgeJournals(
  sides: { launch: Launcher; side?: 'local' }[],
  linkId: string,
  keep: string[],
  minAgeMs?: number,
): Promise<void> {
  const results = await Promise.allSettled(
    sides.map((s) =>
      purgeRuns(s.launch, {
        linkId,
        keep,
        ...(s.side ? { side: s.side } : {}),
        ...(minAgeMs !== undefined ? { minAgeMs } : {}),
      }),
    ),
  );
  for (const r of results)
    if (r.status === 'rejected')
      log.warn('project-sync', `Old undo journals not removed: ${clean(r.reason)}`);
}
