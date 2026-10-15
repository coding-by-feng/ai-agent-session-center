/** Explicit owner-local export only. Not imported by startup or exposed through HTTP/cloud. */
import Database from 'better-sqlite3';
import { constants } from 'fs';
import { lstat, mkdir, open } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { databaseDirectory } from '../dbPaths.js';

type RawRow = Record<string, unknown>;

/**
 * `destination` must be a new .json file directly inside the resolved database
 * directory's legacy-resource-tools/. Retain raw columns/body strings, including
 * malformed historical JSON, so recovery does not depend on the removed codecs.
 */
export async function exportLegacyResourceHistory(destination: string): Promise<{
  path: string; transferTasks: number; projectLinks: number; projectRuns: number;
}> {
  const dataDirectory = resolve(databaseDirectory());
  const exportDirectory = join(dataDirectory, 'legacy-resource-tools');
  const path = resolve(destination);
  if (dirname(path) !== exportDirectory || !path.endsWith('.json')) {
    throw new Error('Export must be a new JSON file in the local legacy-resource-tools directory.');
  }
  const dbPath = join(dataDirectory, 'sessions.db');
  let db: Database.Database | undefined;
  try {
    const info = await lstat(dbPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Legacy database must be a regular local file.');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const read = (table: string): RawRow[] | null => {
    if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return null;
    return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as RawRow[];
  };
  let transfers: RawRow[] | null = null;
  let projectSync: { links: RawRow[]; base: RawRow[]; runs: RawRow[]; entries: RawRow[] };
  try {
    // Read one SQLite snapshot. No migration, interruption marking or helper/service loading.
    const snapshot = () => ({ transfers: read('resource_transfer_state'), projectSync: {
      links: read('project_sync_links') ?? [], base: read('project_sync_base') ?? [],
      runs: read('project_sync_runs') ?? [], entries: read('project_sync_entries') ?? [],
    } });
    ({ transfers, projectSync } = db ? db.transaction(snapshot)() : snapshot());
  } finally { db?.close(); }
  let transferTasks = 0;
  for (const row of transfers ?? []) {
    try { const parsed: unknown = JSON.parse(String(row.body));
      if (parsed && typeof parsed === 'object' && 'tasks' in parsed && Array.isArray(parsed.tasks)) transferTasks += parsed.tasks.length;
    } catch { /* Preserve malformed raw metadata; no inferred tasks. */ }
  }
  // Destination is owner-only and never replaces an existing recovery export.
  await mkdir(dataDirectory, { recursive: true });
  try { await mkdir(exportDirectory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const directory = await lstat(exportDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && directory.uid !== process.getuid())) {
    throw new Error('Legacy export directory must be private to this user and not a link.');
  }
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify({ format: 'aasc-legacy-resources-v1', exportedAt: new Date().toISOString(), transfers, projectSync }, null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  return { path, transferTasks, projectLinks: projectSync.links.length, projectRuns: projectSync.runs.length };
}
