/**
 * The AASC data bundle of Copy / Move a project (server/projectTransfer/aascBundle.ts).
 *
 * Two fresh in-memory databases stand in for the source and target computers. They use
 * Node's built-in `node:sqlite`, not better-sqlite3: the latter's binding is usually built
 * for Electron's ABI and cannot load here, and the module only needs prepare/exec. db.ts
 * and noteMedia.ts are mocked, so the real sessions.db and note-media folder are never
 * opened; every media folder is a fresh temp directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

vi.mock('../server/db.js', () => ({
  dbHandle: () => {
    throw new Error('test must pass its own db');
  },
}));
vi.mock('../server/noteMedia.js', () => ({
  NOTE_MEDIA_DIR: '/nonexistent-test-note-media',
  MAX_MEDIA_BYTES: 25 * 1024 * 1024,
}));

import {
  AascBundleSchema,
  exportAascBundle,
  importAascBundle,
  rerootPath,
  type AascBundle,
  type SqlDb,
} from '../server/projectTransfer/aascBundle.js';

// Mirrors server/db.ts's tables, including the columns added by migration.
const SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_path TEXT, project_name TEXT, title TEXT, model TEXT, status TEXT,
    source TEXT DEFAULT 'hook', label TEXT, summary TEXT, remark TEXT, team_id TEXT, team_role TEXT,
    character_model TEXT, accent_color TEXT, started_at INTEGER, ended_at INTEGER, last_activity_at INTEGER,
    total_prompts INTEGER DEFAULT 0, total_tool_calls INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
    remote_visible INTEGER DEFAULT 0, ai_popup_enabled INTEGER DEFAULT 1
  );
  CREATE TABLE prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT, timestamp INTEGER);
  CREATE UNIQUE INDEX idx_prompts_dedup ON prompts(session_id, timestamp);
  CREATE TABLE responses (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text_excerpt TEXT, timestamp INTEGER);
  CREATE UNIQUE INDEX idx_responses_dedup ON responses(session_id, timestamp);
  CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT, tool_input_summary TEXT, timestamp INTEGER);
  CREATE UNIQUE INDEX idx_tool_calls_dedup ON tool_calls(session_id, timestamp, tool_name);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event_type TEXT, detail TEXT, timestamp INTEGER);
  CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE note_media (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT, mime TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE session_queues (session_id TEXT PRIMARY KEY, items TEXT NOT NULL, automation TEXT, updated_at INTEGER NOT NULL);
`;

const ROOT = '/Users/a/Documents/my_proj';
const TO = '/Users/b/Work/moved';
const MEDIA_ID = 'a'.repeat(32);
const MEDIA_BYTES = Buffer.from('fake-png-bytes');

let scratch: string;
let srcMedia: string;
let dstMedia: string;
let source: DatabaseSync;
let target: DatabaseSync;

function freshDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}

const asDb = (d: DatabaseSync): SqlDb => d as unknown as SqlDb;

function addSession(d: DatabaseSync, id: string, path: string, extra: Record<string, unknown> = {}): void {
  const row = { status: 'working', remote_visible: 1, last_activity_at: 5_000, started_at: 1_000, project_name: path.split('/').pop(), ...extra };
  const cols = ['id', 'project_path', ...Object.keys(row)];
  d.prepare(`INSERT INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(
    id,
    path,
    ...(Object.values(row) as (string | number | null)[]),
  );
}

function seedSource(): void {
  addSession(source, 's-root', ROOT, { title: 'root session' });
  addSession(source, 's-sub', `${ROOT}/packages/api`);
  addSession(source, 's-sibling', `${ROOT}-other`);
  addSession(source, 's-wild', '/Users/a/Documents/myXproj'); // matches `my_proj` only if `_` is unescaped
  addSession(source, 's-wild-sub', '/Users/a/Documents/myXproj/sub');
  source.prepare('INSERT INTO prompts (session_id, text, timestamp) VALUES (?, ?, ?)').run('s-root', 'hello', 10);
  source.prepare('INSERT INTO prompts (session_id, text, timestamp) VALUES (?, ?, ?)').run('s-root', 'again', 11);
  source.prepare('INSERT INTO prompts (session_id, text, timestamp) VALUES (?, ?, ?)').run('s-sibling', 'nope', 12);
  source.prepare('INSERT INTO responses (session_id, text_excerpt, timestamp) VALUES (?, ?, ?)').run('s-root', 'hi', 13);
  source.prepare('INSERT INTO tool_calls (session_id, tool_name, tool_input_summary, timestamp) VALUES (?, ?, ?, ?)').run('s-sub', 'Bash', 'ls', 14);
  source.prepare('INSERT INTO events (session_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)').run('s-sub', 'Stop', null, 15);
  source.prepare('INSERT INTO notes (session_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)').run('s-root', `![x](/api/note-media/${MEDIA_ID})`, 16, 16);
  source.prepare('INSERT INTO note_media VALUES (?, ?, ?, ?, ?, ?, ?)').run(MEDIA_ID, 's-root', 'x.png', 'image/png', 'png', MEDIA_BYTES.length, 17);
  source
    .prepare('INSERT INTO session_queues VALUES (?, ?, ?, ?)')
    .run('s-root', JSON.stringify([{ id: 1, sessionId: 's-root', text: 'next', position: 0 }]), JSON.stringify({ paused: false, autoSend: true }), 18);
  source.prepare('INSERT INTO session_queues VALUES (?, ?, ?, ?)').run('s-sub', JSON.stringify([{ id: 2, text: 'x' }]), null, 19);
  writeFileSync(join(srcMedia, `${MEDIA_ID}.png`), MEDIA_BYTES);
}

/** What the transport would stage on the target: `media/<sid>/<file>`. */
function stage(exported: ReturnType<typeof exportAascBundle>): string {
  const staged = join(scratch, 'staged');
  for (const m of exported.media) {
    const to = join(staged, m.rel);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(m.abs));
  }
  return staged;
}

function roundTrip(): { bundle: AascBundle; staged: string } {
  const exported = exportAascBundle(ROOT, { db: asDb(source), noteMediaDir: srcMedia });
  return { bundle: JSON.parse(JSON.stringify(exported.bundle)) as AascBundle, staged: stage(exported) };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aasc-bundle-test-'));
  srcMedia = join(scratch, 'src-media');
  dstMedia = join(scratch, 'dst-media');
  mkdirSync(srcMedia);
  source = freshDb();
  target = freshDb();
  seedSource();
});

afterEach(() => {
  source.close();
  target.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('exportAascBundle', () => {
  it('takes the root and its subfolders, not a sibling or a LIKE-wildcard match', () => {
    const { bundle, counts, media } = exportAascBundle(ROOT, { db: asDb(source), noteMediaDir: srcMedia });
    expect(bundle.sessions.map((s) => s.id).sort()).toEqual(['s-root', 's-sub']);
    expect(bundle.prompts.map((p) => p.text)).toEqual(['hello', 'again']);
    expect(bundle.toolCalls).toHaveLength(1);
    expect(bundle.events).toHaveLength(1);
    expect(counts).toEqual({ sessions: 2, prompts: 2, notes: 1, media: 1, queues: 2 });
    expect(media).toEqual([{ rel: `media/s-root/${MEDIA_ID}.png`, abs: join(srcMedia, `${MEDIA_ID}.png`), size: MEDIA_BYTES.length }]);
    expect(AascBundleSchema.safeParse(JSON.parse(JSON.stringify(bundle))).success).toBe(true);
  });

  it('leaves out a media row whose file is missing', () => {
    rmSync(join(srcMedia, `${MEDIA_ID}.png`));
    const { bundle, media } = exportAascBundle(ROOT, { db: asDb(source), noteMediaDir: srcMedia });
    expect(bundle.noteMedia).toEqual([]);
    expect(media).toEqual([]);
  });
});

describe('importAascBundle', () => {
  it('round-trips into a fresh DB, re-rooted, ended, hidden and paused', () => {
    const { bundle, staged } = roundTrip();
    const counts = importAascBundle(bundle, { toRoot: TO, mediaDir: staged, db: asDb(target), noteMediaDir: dstMedia, now: 99_000 });
    expect(counts).toEqual({ sessions: 2, prompts: 2, notes: 1, media: 1, queues: 2 });

    const rows = target.prepare('SELECT * FROM sessions ORDER BY id').all() as Record<string, unknown>[];
    expect(rows.map((r) => [r.id, r.project_path, r.project_name])).toEqual([
      ['s-root', TO, 'moved'],
      ['s-sub', `${TO}/packages/api`, 'api'],
    ]);
    for (const r of rows) {
      expect(r.status).toBe('ended');
      expect(r.remote_visible).toBe(0);
      expect(r.ended_at).toBe(5_000); // last_activity_at, since none was ended
    }
    expect(rows[0].title).toBe('root session');

    const queues = target.prepare('SELECT * FROM session_queues ORDER BY session_id').all() as Record<string, unknown>[];
    expect(queues).toHaveLength(2);
    for (const q of queues) {
      expect(JSON.parse(q.automation as string).paused).toBe(true);
      expect(q.updated_at).toBe(99_000);
    }
    expect(JSON.parse(queues[0].automation as string).autoSend).toBe(true); // other switches kept
    expect(JSON.parse(queues[1].automation as string).autoSend).toBe(false); // none stored → safe record
    expect(JSON.parse(queues[0].items as string)[0].text).toBe('next');

    expect(readFileSync(join(dstMedia, `${MEDIA_ID}.png`))).toEqual(MEDIA_BYTES);
    expect(target.prepare('SELECT COUNT(*) AS n FROM note_media').get()).toEqual({ n: 1 });
  });

  it('keeps an existing ended_at', () => {
    source.prepare('UPDATE sessions SET ended_at = 4000 WHERE id = ?').run('s-root');
    const { bundle, staged } = roundTrip();
    importAascBundle(bundle, { toRoot: TO, mediaDir: staged, db: asDb(target), noteMediaDir: dstMedia });
    expect((target.prepare('SELECT ended_at FROM sessions WHERE id = ?').get('s-root') as { ended_at: number }).ended_at).toBe(4000);
  });

  it('skips a session id the target already has, with all its rows', () => {
    addSession(target, 's-root', '/elsewhere', { title: 'mine' });
    const { bundle, staged } = roundTrip();
    const counts = importAascBundle(bundle, { toRoot: TO, mediaDir: staged, db: asDb(target), noteMediaDir: dstMedia });
    expect(counts).toEqual({ sessions: 1, prompts: 0, notes: 0, media: 0, queues: 1 });
    expect(target.prepare('SELECT title, project_path FROM sessions WHERE id = ?').get('s-root')).toEqual({ title: 'mine', project_path: '/elsewhere' });
    expect(target.prepare('SELECT COUNT(*) AS n FROM prompts').get()).toEqual({ n: 0 });
    expect(existsSync(join(dstMedia, `${MEDIA_ID}.png`))).toBe(false);
  });

  it('skips a session outside sourceRoot', () => {
    const { bundle, staged } = roundTrip();
    bundle.sessions[1] = { ...bundle.sessions[1], project_path: `${ROOT}-other/x` };
    const counts = importAascBundle(bundle, { toRoot: TO, mediaDir: staged, db: asDb(target), noteMediaDir: dstMedia });
    expect(counts.sessions).toBe(1);
  });

  it('never overwrites a media file already there', () => {
    const { bundle, staged } = roundTrip();
    mkdirSync(dstMedia, { recursive: true });
    writeFileSync(join(dstMedia, `${MEDIA_ID}.png`), 'someone else');
    const counts = importAascBundle(bundle, { toRoot: TO, mediaDir: staged, db: asDb(target), noteMediaDir: dstMedia });
    expect(readFileSync(join(dstMedia, `${MEDIA_ID}.png`), 'utf8')).toBe('someone else');
    expect(counts.media).toBe(0);
    expect(target.prepare('SELECT COUNT(*) AS n FROM note_media').get()).toEqual({ n: 0 });
  });

  it('skips a staged media file whose size does not match', () => {
    const { bundle, staged } = roundTrip();
    writeFileSync(join(staged, 'media', 's-root', `${MEDIA_ID}.png`), 'short');
    const counts = importAascBundle(bundle, { toRoot: TO, mediaDir: staged, db: asDb(target), noteMediaDir: dstMedia });
    expect(counts.media).toBe(0);
    expect(existsSync(join(dstMedia, `${MEDIA_ID}.png`))).toBe(false);
  });

  it('rolls back rows and copied files when a write fails', () => {
    const { bundle, staged } = roundTrip();
    // The queue insert (the last step, after media is copied) throws.
    target.exec("CREATE TRIGGER boom BEFORE INSERT ON session_queues BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => importAascBundle(bundle, { toRoot: TO, mediaDir: staged, db: asDb(target), noteMediaDir: dstMedia })).toThrow();
    expect(target.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(existsSync(join(dstMedia, `${MEDIA_ID}.png`))).toBe(false);
  });
});

describe('AascBundleSchema', () => {
  const base = (): AascBundle => roundTrip().bundle;

  it('rejects a bad session id', () => {
    const b = base();
    b.sessions[0] = { ...b.sessions[0], id: '../evil' };
    expect(AascBundleSchema.safeParse(b).success).toBe(false);
    const c = base();
    c.prompts[0] = { ...c.prompts[0], session_id: 'a b' };
    expect(AascBundleSchema.safeParse(c).success).toBe(false);
  });

  it('rejects a traversal media id, an odd extension or a non-allow-listed mime', () => {
    const m = base().noteMedia[0];
    for (const bad of [{ id: '../../etc/passwd' }, { ext: 'png/..' }, { mime: 'text/html', ext: 'html' }, { mime: 'image/svg+xml', ext: 'svg' }, { mime: 'image/png', ext: 'jpg' }]) {
      const b = base();
      b.noteMedia = [{ ...m, ...bad }];
      expect(AascBundleSchema.safeParse(b).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects oversized arrays, unknown keys, a relative root and a wrong version', () => {
    const b = base();
    b.notes = Array.from({ length: 50_001 }, () => ({ session_id: 's-root', text: 'x', created_at: 1, updated_at: 1 }));
    expect(AascBundleSchema.safeParse(b).success).toBe(false);
    expect(AascBundleSchema.safeParse({ ...base(), extra: 1 }).success).toBe(false);
    expect(AascBundleSchema.safeParse({ ...base(), sourceRoot: 'relative/path' }).success).toBe(false);
    expect(AascBundleSchema.safeParse({ ...base(), version: 2 }).success).toBe(false);
  });

  it('import refuses an invalid bundle before writing anything', () => {
    expect(() => importAascBundle({ version: 1 }, { toRoot: TO, mediaDir: scratch, db: asDb(target), noteMediaDir: dstMedia })).toThrow();
    expect(target.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });
});

describe('rerootPath', () => {
  it('maps only the root and paths inside it', () => {
    expect(rerootPath('/a/b', '/a/b', '/x')).toBe('/x');
    expect(rerootPath('/a/b/c', '/a/b', '/x')).toBe('/x/c');
    expect(rerootPath('/a/bc', '/a/b', '/x')).toBeNull();
  });
});
