/**
 * A project's AASC data as one portable bundle (Copy / Move a project, P2 — src/types/projectTransfer.ts).
 *
 * Export (source): every `sessions` row whose `project_path` is the project folder or inside it,
 * with those sessions' prompts, responses, tool calls, events, notes, note-media metadata and
 * shared queue, plus the list of note-media files on disk. The transport carries the bundle as
 * `aasc/bundle.json` and each file as `aasc/media/<sessionId>/<id>.<ext>`.
 *
 * Import (target): the bundle comes from ANOTHER computer, so it is validated strictly
 * (`AascBundleSchema`) and written as history only:
 *   - `project_path` is re-rooted from `sourceRoot` to `toRoot`; a session outside it is skipped.
 *   - A session id the target already has is skipped with all its rows.
 *   - Sessions arrive `ended` and hidden from remote devices (`remote_visible = 0`).
 *   - Queues arrive with `automation.paused = true`, the queue's hard stop (⚡ NOW included), so
 *     nothing imported ever sends on its own.
 *   - Only known columns are written; the in-memory session store is not touched.
 *
 * Note media: noteMedia.ts keeps files FLAT as `<NOTE_MEDIA_DIR>/<id>.<ext>` (only the bundle
 * nests them by session), so a file is copied there, never over an existing one
 * (COPYFILE_EXCL), and only when its metadata row was inserted and its size matches `bytes`.
 * The `mime` is checked against noteMedia's allow-list, because it becomes the served
 * Content-Type of a same-origin URL.
 *
 * Atomicity: every DB write runs in ONE transaction and media files are copied inside it,
 * before COMMIT. If anything throws, the transaction is rolled back and every file this call
 * created is deleted, so a failed import leaves neither rows nor files behind.
 */
import { constants as fsConstants, copyFileSync, lstatSync, mkdirSync, rmSync, statSync } from 'fs';
import { basename, isAbsolute, join } from 'path';
import { z } from 'zod';
import { dbHandle } from '../db.js';
import { MAX_MEDIA_BYTES, NOTE_MEDIA_DIR } from '../noteMedia.js';
import { decodeQueueRow, encodeQueue, nextQueueVersion } from '../sessionQueueCodec.js';
import type { SessionQueueRow } from '../sessionQueueCodec.js';
import type { AascBundleCounts } from '../../src/types/projectTransfer.js';

export const AASC_BUNDLE_VERSION = 1;

// ---- Row shapes (snake_case, as the tables store them) ----

export interface AascSessionRow {
  id: string;
  project_path: string;
  project_name: string | null;
  title: string | null;
  model: string | null;
  status: string | null;
  source: string | null;
  label: string | null;
  summary: string | null;
  remark: string | null;
  team_id: string | null;
  team_role: string | null;
  character_model: string | null;
  accent_color: string | null;
  started_at: number | null;
  ended_at: number | null;
  last_activity_at: number | null;
  total_prompts: number | null;
  total_tool_calls: number | null;
  archived: number | null;
  ai_popup_enabled: number | null;
}
export interface AascPromptRow { session_id: string; text: string | null; timestamp: number | null }
export interface AascResponseRow { session_id: string; text_excerpt: string | null; timestamp: number | null }
export interface AascToolCallRow { session_id: string; tool_name: string | null; tool_input_summary: string | null; timestamp: number | null }
export interface AascEventRow { session_id: string; event_type: string | null; detail: string | null; timestamp: number | null }
export interface AascNoteRow { session_id: string; text: string | null; created_at: number | null; updated_at: number | null }
export interface AascNoteMediaRow { id: string; session_id: string; name: string | null; mime: string; ext: string; bytes: number; created_at: number }
export interface AascQueueRow { session_id: string; items: Record<string, unknown>[]; automation: Record<string, unknown> | null; updated_at: number }

export interface AascBundle {
  version: 1;
  sourceRoot: string;
  exportedAt: number;
  sessions: AascSessionRow[];
  prompts: AascPromptRow[];
  responses: AascResponseRow[];
  toolCalls: AascToolCallRow[];
  events: AascEventRow[];
  notes: AascNoteRow[];
  noteMedia: AascNoteMediaRow[];
  queues: AascQueueRow[];
}

export interface ExportedAasc {
  bundle: AascBundle;
  /** `rel` = `media/<sessionId>/<id>.<ext>`; `abs` = the file on this computer. */
  media: { rel: string; abs: string; size: number }[];
  counts: AascBundleCounts;
}

/** The handle shape this module needs; better-sqlite3 (and node:sqlite in tests) fit it. */
interface SqlStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}
export interface SqlDb {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
}
export interface AascBundleDeps {
  db?: SqlDb;
  noteMediaDir?: string;
}

// ---- Validation ----

/** noteMedia.ts's MIME allow-list (not exported there); SVG stays out (stored XSS). */
const MEDIA_MIME_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
});

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_ID_RE = /^[a-f0-9]{32}$/;
const SHORT = 4_096;
const LONG = 2 * 1024 * 1024;
const MAX_QUEUE_JSON = 16 * 1024 * 1024;

const sid = z.string().regex(SESSION_ID_RE);
const shortStr = z.string().max(SHORT).nullable();
const longStr = z.string().max(LONG).nullable();
const int = z.number().int().nullable();
const absPath = z.string().min(1).max(SHORT).refine((p) => isAbsolute(p) && !p.includes('\0'), 'absolute path');

const SessionRowSchema = z.strictObject({
  id: sid,
  project_path: absPath,
  project_name: shortStr,
  title: shortStr,
  model: shortStr,
  status: shortStr,
  source: shortStr,
  label: shortStr,
  summary: longStr,
  remark: longStr,
  team_id: shortStr,
  team_role: shortStr,
  character_model: shortStr,
  accent_color: shortStr,
  started_at: int,
  ended_at: int,
  last_activity_at: int,
  total_prompts: int,
  total_tool_calls: int,
  archived: int,
  ai_popup_enabled: int,
});

const NoteMediaRowSchema = z
  .strictObject({
    id: z.string().regex(MEDIA_ID_RE),
    session_id: sid,
    name: z.string().max(255).nullable(),
    mime: z.string().max(64),
    ext: z.string().regex(/^[a-z0-9]{1,8}$/),
    bytes: z.number().int().min(1).max(MAX_MEDIA_BYTES),
    created_at: z.number().int(),
  })
  .refine((m) => MEDIA_MIME_EXT[m.mime] === m.ext, 'mime/ext not allowed');

const QueueRowSchema = z
  .strictObject({
    session_id: sid,
    items: z.array(z.record(z.string(), z.unknown())).max(2_000),
    automation: z.record(z.string(), z.unknown()).nullable(),
    updated_at: z.number().int(),
  })
  .refine((q) => JSON.stringify(q.items).length + JSON.stringify(q.automation).length <= MAX_QUEUE_JSON, 'queue too large');

export const AascBundleSchema: z.ZodType<AascBundle> = z.strictObject({
  version: z.literal(AASC_BUNDLE_VERSION),
  sourceRoot: absPath,
  exportedAt: z.number().int(),
  sessions: z.array(SessionRowSchema).max(10_000),
  prompts: z.array(z.strictObject({ session_id: sid, text: longStr, timestamp: int })).max(500_000),
  responses: z.array(z.strictObject({ session_id: sid, text_excerpt: longStr, timestamp: int })).max(500_000),
  toolCalls: z
    .array(z.strictObject({ session_id: sid, tool_name: shortStr, tool_input_summary: longStr, timestamp: int }))
    .max(1_000_000),
  events: z.array(z.strictObject({ session_id: sid, event_type: shortStr, detail: longStr, timestamp: int })).max(1_000_000),
  notes: z.array(z.strictObject({ session_id: sid, text: longStr, created_at: int, updated_at: int })).max(50_000),
  noteMedia: z.array(NoteMediaRowSchema).max(20_000),
  queues: z.array(QueueRowSchema).max(10_000),
});

// ---- Helpers ----

const SESSION_COLUMNS = Object.keys(SessionRowSchema.shape) as (keyof AascSessionRow)[];

function trimRoot(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `p` re-rooted from `from` to `to`, or null when `p` is not `from` or inside it. */
export function rerootPath(p: string, from: string, to: string): string | null {
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return null;
}

function mediaFileName(m: { id: string; ext: string }): string {
  return `${m.id}.${m.ext}`;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** Rows for a set of sessions, in chunks under SQLite's bound-parameter limit. */
function rowsFor<T>(db: SqlDb, sql: (inList: string) => string, ids: string[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...(db.prepare(sql(placeholders(chunk.length))).all(...chunk) as T[]));
  }
  return out;
}

const pickStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const pickInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'bigint' ? Number(v) : null);

function toSessionRow(raw: Record<string, unknown>): AascSessionRow {
  const row = {} as Record<string, unknown>;
  for (const col of SESSION_COLUMNS) {
    const v = raw[col];
    row[col] = typeof v === 'number' || typeof v === 'bigint' ? pickInt(v) : pickStr(v);
  }
  return row as unknown as AascSessionRow;
}

// ---- Export ----

export function exportAascBundle(root: string, deps: AascBundleDeps = {}): ExportedAasc {
  const db = deps.db ?? dbHandle();
  const mediaDir = deps.noteMediaDir ?? NOTE_MEDIA_DIR;
  const sourceRoot = trimRoot(root);

  const sessionRaw = db
    .prepare("SELECT * FROM sessions WHERE project_path = ? OR project_path LIKE ? ESCAPE '\\' ORDER BY started_at")
    .all(sourceRoot, `${escapeLike(sourceRoot)}/%`) as Record<string, unknown>[];
  const sessions = sessionRaw.filter((r) => typeof r.id === 'string' && SESSION_ID_RE.test(r.id)).map(toSessionRow);
  const ids = sessions.map((s) => s.id);

  const select = (cols: string, table: string, order: string) => (inList: string) =>
    `SELECT ${cols} FROM ${table} WHERE session_id IN (${inList}) ORDER BY ${order}`;
  const prompts = rowsFor<AascPromptRow>(db, select('session_id, text, timestamp', 'prompts', 'id'), ids);
  const responses = rowsFor<AascResponseRow>(db, select('session_id, text_excerpt, timestamp', 'responses', 'id'), ids);
  const toolCalls = rowsFor<AascToolCallRow>(db, select('session_id, tool_name, tool_input_summary, timestamp', 'tool_calls', 'id'), ids);
  const events = rowsFor<AascEventRow>(db, select('session_id, event_type, detail, timestamp', 'events', 'id'), ids);
  const notes = rowsFor<AascNoteRow>(db, select('session_id, text, created_at, updated_at', 'notes', 'id'), ids);
  const mediaRows = rowsFor<AascNoteMediaRow>(db, select('id, session_id, name, mime, ext, bytes, created_at', 'note_media', 'created_at'), ids);
  const queueRows = rowsFor<SessionQueueRow>(db, select('session_id, items, automation, updated_at', 'session_queues', 'session_id'), ids);

  // Only media whose file is here, with an id/ext that keeps the path inside the folder.
  const noteMedia: AascNoteMediaRow[] = [];
  const media: ExportedAasc['media'] = [];
  for (const m of mediaRows) {
    if (!MEDIA_ID_RE.test(m.id) || MEDIA_MIME_EXT[m.mime] !== m.ext) continue;
    const abs = join(mediaDir, mediaFileName(m));
    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    noteMedia.push({ ...m, bytes: size });
    media.push({ rel: `media/${m.session_id}/${mediaFileName(m)}`, abs, size });
  }

  const queues: AascQueueRow[] = [];
  for (const row of queueRows) {
    const decoded = decodeQueueRow(row);
    if (!decoded) continue;
    const items = decoded.items.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && !Array.isArray(i));
    const automation = decoded.automation && typeof decoded.automation === 'object' && !Array.isArray(decoded.automation)
      ? (decoded.automation as Record<string, unknown>)
      : null;
    queues.push({ session_id: decoded.sessionId, items, automation, updated_at: decoded.updatedAt });
  }

  const bundle: AascBundle = {
    version: AASC_BUNDLE_VERSION,
    sourceRoot,
    exportedAt: Date.now(),
    sessions,
    prompts,
    responses,
    toolCalls,
    events,
    notes,
    noteMedia,
    queues,
  };
  return {
    bundle,
    media,
    counts: { sessions: sessions.length, prompts: prompts.length, notes: notes.length, media: media.length, queues: queues.length },
  };
}

// ---- Import ----

/** The record MCP's queue tools write when none is stored and the change only stops things. */
const SAFE_AUTOMATION: Readonly<Record<string, unknown>> = Object.freeze({
  autoSend: false,
  autoEnter: false,
  idleGuard: true,
  skipWhenPrompting: true,
  autoResume: false,
  resumeMaxRetries: 3,
  resumePrompt: '',
});

/** An imported queue is always paused: the scheduler's hard stop, ⚡ NOW included. */
export function pausedAutomation(stored: Record<string, unknown> | null): Record<string, unknown> {
  return { ...(stored ?? SAFE_AUTOMATION), paused: true };
}

export interface ImportAascOptions extends AascBundleDeps {
  toRoot: string;
  /** The staged folder holding `media/<sessionId>/<file>`. */
  mediaDir: string;
  now?: number;
}

function changed(r: { changes: number | bigint }): boolean {
  return Number(r.changes) > 0;
}

export function importAascBundle(raw: unknown, opts: ImportAascOptions): AascBundleCounts {
  const bundle = AascBundleSchema.parse(raw);
  if (!isAbsolute(opts.toRoot)) throw new Error('toRoot must be an absolute path');
  const db = opts.db ?? dbHandle();
  const noteMediaDir = opts.noteMediaDir ?? NOTE_MEDIA_DIR;
  const now = opts.now ?? Date.now();
  const from = trimRoot(bundle.sourceRoot);
  const to = trimRoot(opts.toRoot);

  const tableCols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name));
  const writeCols = [...SESSION_COLUMNS, 'remote_visible'].filter((c) => tableCols.has(c));
  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO sessions (${writeCols.join(', ')}) VALUES (${placeholders(writeCols.length)})`,
  );
  const existsSession = db.prepare('SELECT 1 FROM sessions WHERE id = ?');
  const insertPrompt = db.prepare('INSERT OR IGNORE INTO prompts (session_id, text, timestamp) VALUES (?, ?, ?)');
  const insertResponse = db.prepare('INSERT OR IGNORE INTO responses (session_id, text_excerpt, timestamp) VALUES (?, ?, ?)');
  const insertToolCall = db.prepare(
    'INSERT OR IGNORE INTO tool_calls (session_id, tool_name, tool_input_summary, timestamp) VALUES (?, ?, ?, ?)',
  );
  const insertEvent = db.prepare('INSERT INTO events (session_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)');
  const insertNote = db.prepare('INSERT INTO notes (session_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const insertMedia = db.prepare(
    'INSERT OR IGNORE INTO note_media (id, session_id, name, mime, ext, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const deleteMedia = db.prepare('DELETE FROM note_media WHERE id = ?');
  const insertQueue = db.prepare(
    'INSERT OR IGNORE INTO session_queues (session_id, items, automation, updated_at) VALUES (?, ?, ?, ?)',
  );

  const counts: AascBundleCounts = { sessions: 0, prompts: 0, notes: 0, media: 0, queues: 0 };
  const created: string[] = [];
  const inserted = new Set<string>();

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of bundle.sessions) {
      const path = rerootPath(trimRoot(s.project_path), from, to);
      if (path === null || existsSession.get(s.id)) continue;
      const oldName = basename(trimRoot(s.project_path));
      const row: Record<string, unknown> = {
        ...s,
        project_path: path,
        project_name: s.project_name === oldName ? basename(path) : s.project_name,
        status: 'ended',
        ended_at: s.ended_at ?? s.last_activity_at ?? now,
        remote_visible: 0,
      };
      if (!changed(insertSession.run(...writeCols.map((c) => row[c] ?? null)))) continue;
      inserted.add(s.id);
      counts.sessions++;
    }

    for (const p of bundle.prompts) {
      if (inserted.has(p.session_id) && changed(insertPrompt.run(p.session_id, p.text, p.timestamp))) counts.prompts++;
    }
    for (const r of bundle.responses) {
      if (inserted.has(r.session_id)) insertResponse.run(r.session_id, r.text_excerpt, r.timestamp);
    }
    for (const t of bundle.toolCalls) {
      if (inserted.has(t.session_id)) insertToolCall.run(t.session_id, t.tool_name, t.tool_input_summary, t.timestamp);
    }
    for (const e of bundle.events) {
      if (inserted.has(e.session_id)) insertEvent.run(e.session_id, e.event_type, e.detail, e.timestamp);
    }
    for (const n of bundle.notes) {
      if (inserted.has(n.session_id) && changed(insertNote.run(n.session_id, n.text, n.created_at, n.updated_at))) counts.notes++;
    }

    for (const m of bundle.noteMedia) {
      if (!inserted.has(m.session_id)) continue;
      const file = mediaFileName(m);
      const src = join(opts.mediaDir, 'media', m.session_id, file);
      try {
        const st = lstatSync(src);
        if (!st.isFile() || st.size !== m.bytes) continue;
      } catch {
        continue;
      }
      if (!changed(insertMedia.run(m.id, m.session_id, m.name, m.mime, m.ext, m.bytes, m.created_at))) continue;
      const dst = join(noteMediaDir, file);
      mkdirSync(noteMediaDir, { recursive: true });
      try {
        copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
        created.push(dst);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Never overwrite. A file already there with the same size is this media (an
        // earlier attempt's leftover); any other file keeps its bytes and the row goes.
        const existing = statSync(dst);
        if (!existing.isFile() || existing.size !== m.bytes) {
          deleteMedia.run(m.id);
          continue;
        }
      }
      counts.media++;
    }

    for (const q of bundle.queues) {
      if (!inserted.has(q.session_id)) continue;
      const enc = encodeQueue(q.items, pausedAutomation(q.automation));
      if (changed(insertQueue.run(q.session_id, enc.items, enc.automation, nextQueueVersion(null, now)))) counts.queues++;
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction already ended */
    }
    for (const f of created) rmSync(f, { force: true });
    throw err;
  }
  return counts;
}
