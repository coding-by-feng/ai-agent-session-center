/**
 * Project Sync persistence. Four small tables, never the single resource_transfer_state
 * row: a plan can hold 100k entries and a base one row per file.
 * Bodies are JSON — metadata only (paths, sizes, hashes); no file bytes ever.
 */
import type { SyncEntry, SyncLink, SyncRun, FileMeta } from '../../src/types/projectSync.js';

/** A link plus the one field that never leaves the server: this machine's absolute folder. */
export interface StoredLink extends SyncLink {
  localRoot: string;
}

export interface SyncStore {
  loadLinks(): Promise<StoredLink[]>;
  saveLink(link: StoredLink): Promise<void>;
  deleteLink(id: string): Promise<void>;
  loadBase(linkId: string): Promise<Map<string, FileMeta>>;
  replaceBase(linkId: string, base: Map<string, FileMeta>): Promise<void>;
  loadRuns(): Promise<SyncRun[]>;
  saveRun(run: SyncRun): Promise<void>;
  deleteRun(id: string): Promise<void>;
  loadEntries(runId: string): Promise<SyncEntry[]>;
  /** Insert or replace these entries (all of them, or just the ones that changed). */
  saveEntries(runId: string, entries: SyncEntry[]): Promise<void>;
}

/** Tests and the default share one shape. */
export function memoryStore(): SyncStore {
  const links = new Map<string, StoredLink>(),
    bases = new Map<string, Map<string, FileMeta>>(),
    runs = new Map<string, SyncRun>(),
    entries = new Map<string, Map<string, SyncEntry>>();
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    loadLinks: async () => [...links.values()].map(clone),
    saveLink: async (l) => void links.set(l.id, clone(l)),
    deleteLink: async (id) => {
      links.delete(id);
      bases.delete(id);
    },
    loadBase: async (id) => new Map(clone([...(bases.get(id) ?? new Map())])),
    replaceBase: async (id, b) => void bases.set(id, new Map(clone([...b]))),
    loadRuns: async () => [...runs.values()].map(clone),
    saveRun: async (r) => void runs.set(r.id, clone(r)),
    deleteRun: async (id) => {
      runs.delete(id);
      entries.delete(id);
    },
    loadEntries: async (id) => [...(entries.get(id)?.values() ?? [])].map(clone),
    saveEntries: async (id, list) => {
      const m = entries.get(id) ?? new Map<string, SyncEntry>();
      for (const e of list) m.set(e.id, clone(e));
      entries.set(id, m);
    },
  };
}

export async function sqliteStore(): Promise<SyncStore> {
  const { dbHandle } = await import('../db.js');
  const db = dbHandle();
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_sync_links (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_sync_base (link_id TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (link_id, path));
    CREATE TABLE IF NOT EXISTS project_sync_runs (id TEXT PRIMARY KEY, link_id TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_sync_entries (run_id TEXT NOT NULL, entry_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run_id, entry_id));
  `);
  const insertBase = db.prepare(
    'INSERT INTO project_sync_base (link_id, path, body) VALUES (?, ?, ?)',
  );
  const replaceBase = db.transaction((linkId: string, base: Map<string, FileMeta>) => {
    db.prepare('DELETE FROM project_sync_base WHERE link_id = ?').run(linkId);
    for (const [path, meta] of base) insertBase.run(linkId, path, JSON.stringify(meta));
  });
  const upsertEntry = db.prepare(
    'INSERT INTO project_sync_entries (run_id, entry_id, body) VALUES (?, ?, ?) ON CONFLICT(run_id, entry_id) DO UPDATE SET body = excluded.body',
  );
  const saveEntries = db.transaction((runId: string, list: SyncEntry[]) => {
    for (const e of list) upsertEntry.run(runId, e.id, JSON.stringify(e));
  });
  const deleteRun = db.transaction((id: string) => {
    db.prepare('DELETE FROM project_sync_entries WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM project_sync_runs WHERE id = ?').run(id);
  });
  const deleteLink = db.transaction((id: string) => {
    db.prepare('DELETE FROM project_sync_base WHERE link_id = ?').run(id);
    db.prepare('DELETE FROM project_sync_links WHERE id = ?').run(id);
  });
  return {
    loadLinks: async () =>
      (db.prepare('SELECT body FROM project_sync_links').all() as { body: string }[]).map((r) =>
        JSON.parse(r.body),
      ),
    saveLink: async (l) =>
      void db
        .prepare(
          'INSERT INTO project_sync_links (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
        )
        .run(l.id, JSON.stringify(l)),
    deleteLink: async (id) => deleteLink(id),
    loadBase: async (linkId) =>
      new Map(
        (
          db.prepare('SELECT path, body FROM project_sync_base WHERE link_id = ?').all(linkId) as {
            path: string;
            body: string;
          }[]
        ).map((r) => [r.path, JSON.parse(r.body) as FileMeta]),
      ),
    replaceBase: async (linkId, base) => replaceBase(linkId, base),
    loadRuns: async () =>
      (
        db.prepare('SELECT body FROM project_sync_runs ORDER BY created_at DESC').all() as {
          body: string;
        }[]
      ).map((r) => JSON.parse(r.body)),
    saveRun: async (r) =>
      void db
        .prepare(
          'INSERT INTO project_sync_runs (id, link_id, created_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
        )
        .run(r.id, r.linkId, r.createdAt, JSON.stringify(r)),
    deleteRun: async (id) => deleteRun(id),
    loadEntries: async (runId) =>
      (
        db.prepare('SELECT body FROM project_sync_entries WHERE run_id = ?').all(runId) as {
          body: string;
        }[]
      ).map((r) => JSON.parse(r.body)),
    saveEntries: async (runId, list) => saveEntries(runId, list),
  };
}
