/**
 * Project Sync persistence. Six small tables: a plan can hold 100k entries and a base
 * one row per file. Bodies are JSON — metadata only (paths, sizes, hashes); no file bytes ever.
 * Saved servers lived in the retired Transfers state (`resource_transfer_state`, AASC-51);
 * the first load copies them over once, keeping their ids, so links made then still resolve.
 */
import { invalidDeviceInput } from './servers.js';
import type {
  FileMeta,
  SyncDevice,
  SyncEntry,
  SyncLink,
  SyncRun,
} from '../../src/types/projectSync.js';

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
  loadDevices(): Promise<SyncDevice[]>;
  saveDevice(device: SyncDevice): Promise<void>;
  deleteDevice(id: string): Promise<void>;
}

const DEVICE_KEYS = [
  'id',
  'name',
  'host',
  'username',
  'port',
  'fingerprint',
  'home',
  'platform',
  'checkedAt',
] as const;

/** A saved server from the retired Transfers state, or null when a field is missing, the wrong type, or not a server AASC would add today. */
export function legacyDevice(raw: unknown): SyncDevice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const strings = ['id', 'name', 'host', 'username', 'fingerprint', 'home', 'platform'] as const;
  if (strings.some((k) => typeof r[k] !== 'string' || !(r[k] as string).length)) return null;
  if (!Number.isInteger(r.port) || (r.port as number) < 1 || (r.port as number) > 65535)
    return null;
  const device = Object.fromEntries(DEVICE_KEYS.map((k) => [k, r[k]])) as unknown as SyncDevice;
  if (invalidDeviceInput(device)) return null;
  return { ...device, checkedAt: Number(r.checkedAt) || 0 };
}

/** Tests and the default share one shape. */
export function memoryStore(): SyncStore {
  const links = new Map<string, StoredLink>(),
    bases = new Map<string, Map<string, FileMeta>>(),
    runs = new Map<string, SyncRun>(),
    entries = new Map<string, Map<string, SyncEntry>>(),
    devices = new Map<string, SyncDevice>();
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
    loadDevices: async () => [...devices.values()].map(clone),
    saveDevice: async (d) => void devices.set(d.id, clone(d)),
    deleteDevice: async (id) => void devices.delete(id),
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
    CREATE TABLE IF NOT EXISTS project_sync_devices (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const upsertDevice = db.prepare(
    'INSERT INTO project_sync_devices (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
  );
  // Once: the servers saved under the retired Transfers tab (their ids are what old links name).
  // Marked done, so a server removed later never comes back on the next start.
  const imported = db.prepare("SELECT 1 FROM project_sync_meta WHERE key = 'legacy-devices'").get();
  const hasDevices = db.prepare('SELECT 1 FROM project_sync_devices LIMIT 1').get();
  const legacyTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resource_transfer_state'",
    )
    .get();
  if (!imported && !hasDevices && legacyTable) {
    const row = db.prepare('SELECT body FROM resource_transfer_state WHERE id = 1').get() as
      | { body: string }
      | undefined;
    let list: unknown[] = [];
    try {
      const parsed = row ? (JSON.parse(row.body) as { devices?: unknown }) : null;
      if (parsed && Array.isArray(parsed.devices)) list = parsed.devices;
    } catch {
      /* unreadable legacy state: nothing to copy */
    }
    for (const raw of list) {
      const d = legacyDevice(raw);
      if (d) upsertDevice.run(d.id, JSON.stringify(d));
    }
  }
  if (!imported)
    db.prepare("INSERT INTO project_sync_meta (key, value) VALUES ('legacy-devices', ?)").run(
      String(Date.now()),
    );
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
    loadDevices: async () =>
      (db.prepare('SELECT body FROM project_sync_devices').all() as { body: string }[]).map((r) =>
        JSON.parse(r.body),
      ),
    saveDevice: async (d) => void upsertDevice.run(d.id, JSON.stringify(d)),
    deleteDevice: async (id) =>
      void db.prepare('DELETE FROM project_sync_devices WHERE id = ?').run(id),
  };
}
