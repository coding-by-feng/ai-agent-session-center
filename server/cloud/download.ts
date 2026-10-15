import { lstat, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { syncDirectory } from './installFs.js';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { createWriteStream, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { ResourceVersion } from '../../src/types/cloudResources.js';
import { privateDirectory } from './secretStore.js';
import log from '../logger.js';
/** Prepared exports only: archives are output, never installer input. */
export async function prepareDownload(
  directory: string,
  versions: ResourceVersion[],
  paths: Map<string, string>,
  signal: AbortSignal,
): Promise<string> {
  await privateDirectory(directory);
  const path = join(directory, `${randomUUID()}.zip`);
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(JSON.stringify({ format: 'aasc-resource-v1', resources: versions }, null, 2)),
    'manifest.json',
    { mode: 0o100644 },
  );
  for (const v of versions)
    for (const f of v.manifest.files) {
      const source = paths.get(f.sha256)!;
      zip.addReadStreamLazy(
        `resources/${v.manifest.resourceId}/${v.version}/${f.path}`,
        { size: f.bytes, mode: 0o100000 | f.mode },
        (cb) => {
          void open(source, constants.O_RDONLY | constants.O_NOFOLLOW).then(
            (file) => cb(null, file.createReadStream()),
            (error) => cb(error as Error, Readable.from([])),
          );
        },
      );
    }
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  zip.on('error', (error) => (zip.outputStream as Readable).destroy(error));
  const completion = pipeline(zip.outputStream, output, { signal });
  zip.end();
  await completion;
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
  return path;
}

/** A prepared ZIP is for one save; an unsaved one is swept after this long. */
export const EXPORT_TTL_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZIP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** A real directory (never a link), or null when there is none. */
async function realDirectory(path: string) {
  try {
    const s = await lstat(path);
    return s.isDirectory() && !s.isSymbolicLink() ? s : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
/** Same file system object as when it was checked: a folder swapped for a link fails this. */
const sameEntry = (a: { dev: number; ino: number }, b: { dev: number; ino: number } | null) =>
  !!b && a.dev === b.dev && a.ino === b.ino;
/**
 * Delete one job's prepared export: `<exports>/<jobId>/<uuid>.zip` and its folder.
 * Only regular files with the name prepareDownload gives are removed, nothing is
 * followed, a folder holding anything else is left as it is (rmdir refuses it), and
 * the folder is re-checked before every removal so a swapped-in link is never used.
 */
export async function removeExport(exportsDir: string, jobId: string): Promise<void> {
  if (!UUID_RE.test(jobId)) return;
  const root = await realDirectory(exportsDir);
  if (!root) return;
  const folder = join(exportsDir, jobId);
  const anchor = await realDirectory(folder);
  if (!anchor) return;
  const unchanged = async () =>
    sameEntry(root, await realDirectory(exportsDir)) &&
    sameEntry(anchor, await realDirectory(folder));
  for (const name of await readdir(folder)) {
    if (!ZIP_RE.test(name) || !(await unchanged())) continue;
    const file = join(folder, name);
    const s = await lstat(file).catch(() => null);
    if (s?.isFile() && !s.isSymbolicLink()) await unlink(file).catch(() => {});
  }
  if (await unchanged()) await rmdir(folder).catch(() => {});
}
/** Newest change inside one export folder, or null when it is not a real folder. */
async function lastWritten(folder: string): Promise<number | null> {
  const s = await realDirectory(folder);
  if (!s) return null;
  let newest = s.mtimeMs;
  for (const entry of await readdir(folder)) {
    const e = await lstat(join(folder, entry)).catch(() => null);
    if (e) newest = Math.max(newest, e.mtimeMs);
  }
  return newest;
}
/**
 * Remove exports last written longer ago than `maxAgeMs` (every UUID folder directly
 * in `exportsDir`) and return their job ids. `keep` is asked again right before each
 * removal, and one unreadable folder never stops the rest of the sweep.
 */
export async function sweepExports(
  exportsDir: string,
  options: { now?: number; maxAgeMs?: number; keep?: (jobId: string) => boolean } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now(),
    maxAgeMs = options.maxAgeMs ?? EXPORT_TTL_MS;
  if (!(await realDirectory(exportsDir))) return [];
  const removed: string[] = [];
  for (const name of await readdir(exportsDir)) {
    if (!UUID_RE.test(name) || options.keep?.(name)) continue;
    const folder = join(exportsDir, name);
    try {
      const newest = await lastWritten(folder);
      if (newest === null || now - newest <= maxAgeMs || options.keep?.(name)) continue;
      await removeExport(exportsDir, name);
      if (!(await realDirectory(folder))) removed.push(name);
    } catch (error) {
      // Unreadable (permissions changed under us): left for a later sweep, the rest go on.
      log.warn('cloud', `Skipped prepared download ${name}: ${(error as Error).message}`);
    }
  }
  return removed;
}
