// db.ts — SQLite persistence layer for all session data
// Stores sessions, prompts, responses, tool calls, events, and notes in data/sessions.db
// so all browsers (localhost, LAN IP, etc.) see the same data.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import log from './logger.js';
import { sanitizeModelId, extractModelFromCommand } from './config.js';
import { encodeQueue, decodeQueueRow } from './sessionQueueCodec.js';
import type { SessionQueueRecord, SessionQueueRow } from './sessionQueueCodec.js';
import type { Session } from '../src/types/session.js';
import type {
  DbSessionRow, DbPromptRow, DbResponseRow, DbToolCallRow, DbEventRow, DbNoteRow,
  SessionDetailResponse, SessionSearchResponse, SessionSearchParams,
  FullTextSearchResult, FullTextSearchResponse,
  PromptKind, PromptTraceRow, PromptSearchParams, PromptSearchResponse,
} from '../src/types/api.js';
import type {
  DistinctProject,
} from '../src/types/analytics.js';
import type { AgendaTask } from '../src/types/agenda.js';

const __dbDirname = dirname(fileURLToPath(import.meta.url));
// In packaged Electron, APP_USER_DATA is set to app.getPath('userData') — a writable directory.
// In dev/CLI mode, fall back to the local data/ directory.
const DB_DIR = process.env.APP_USER_DATA
  ? join(process.env.APP_USER_DATA, 'data')
  : join(__dbDirname, '..', 'data');
const DB_PATH = join(DB_DIR, 'sessions.db');

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// ---- Schema ----

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT,
    project_name TEXT,
    title TEXT,
    model TEXT,
    status TEXT,
    source TEXT DEFAULT 'hook',
    label TEXT,
    summary TEXT,
    remark TEXT,
    team_id TEXT,
    team_role TEXT,
    character_model TEXT,
    accent_color TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    last_activity_at INTEGER,
    total_prompts INTEGER DEFAULT 0,
    total_tool_calls INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_activity_at ON sessions(last_activity_at);

  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text TEXT,
    timestamp INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_prompts_session_id ON prompts(session_id);
  CREATE INDEX IF NOT EXISTS idx_prompts_timestamp ON prompts(timestamp);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_dedup ON prompts(session_id, timestamp);

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text_excerpt TEXT,
    timestamp INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_responses_session_id ON responses(session_id);
  CREATE INDEX IF NOT EXISTS idx_responses_timestamp ON responses(timestamp);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_dedup ON responses(session_id, timestamp);

  CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT,
    tool_input_summary TEXT,
    timestamp INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_dedup ON tool_calls(session_id, timestamp, tool_name);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event_type TEXT,
    detail TEXT,
    timestamp INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_notes_session_id ON notes(session_id);

  -- Media embedded in notes. Only metadata lives here; the bytes are files
  -- under <data dir>/note-media/<session_id>/<id>.<ext> so a 40 MB screen
  -- recording never becomes a 40 MB TEXT row that every notes fetch reloads.
  CREATE TABLE IF NOT EXISTS note_media (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_note_media_session_id ON note_media(session_id);
  CREATE INDEX IF NOT EXISTS idx_note_media_created_at ON note_media(created_at);

  CREATE TABLE IF NOT EXISTS agenda_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    tags TEXT NOT NULL DEFAULT '[]',
    due_date TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agenda_tasks_priority ON agenda_tasks(priority);
  CREATE INDEX IF NOT EXISTS idx_agenda_tasks_completed ON agenda_tasks(completed);

  -- Per-session prompt queue, shared across every device.
  --
  -- Until Aug 2026 the queue lived ONLY in each browser's IndexedDB, so a
  -- phone at http://<lan-ip>:<port> and the desktop app kept entirely separate
  -- queues that never synced — the same session showed "QUEUE (0)" on one and
  -- a full list on the other. This table is the shared source of truth.
  --
  -- items and automation are stored as JSON documents rather than normalized
  -- columns ON PURPOSE: the server performs no logic on queue items (the
  -- scheduler is entirely client-side), so it is pure transport+storage.
  -- Normalizing would mean mirroring ~18 QueueItem fields here and keeping
  -- them in lockstep with the client type forever, where a missed field
  -- silently drops user data. A JSON blob carries new fields for free and
  -- cannot drift. (No backticks in this comment — it sits inside a JS
  -- template literal, where one would terminate the SQL string early.)
  CREATE TABLE IF NOT EXISTS session_queues (
    session_id TEXT PRIMARY KEY,
    items TEXT NOT NULL,
    automation TEXT,
    updated_at INTEGER NOT NULL
  );
`);

log.info('db', `SQLite database opened: ${DB_PATH}`);

// ---- Schema migration: add columns to a pre-existing sessions table ----
// `CREATE TABLE IF NOT EXISTS` above is a NO-OP on a database that already
// exists, so a column added to that statement never reaches an installed user —
// their table keeps the shape it was first created with and every read of the
// new column throws "no such column". Add them in place instead. Idempotent:
// PRAGMA table_info is the source of truth, so this is safe to run every boot.
try {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const ADDED_COLUMNS: Array<{ name: string; ddl: string }> = [
    // User-authored progress note shown under the session title in the detail
    // rail. Nullable with no default — an existing row simply has no remark.
    { name: 'remark', ddl: 'ALTER TABLE sessions ADD COLUMN remark TEXT' },
    // Opt-in for remote (non-loopback) devices. INTEGER 0/1, defaulting to 0 —
    // an existing row is hidden, which is the point: deny by default cannot be
    // retrofitted if the migration back-fills the permissive value.
    { name: 'remote_visible', ddl: 'ALTER TABLE sessions ADD COLUMN remote_visible INTEGER DEFAULT 0' },
    // DEFAULT 1, unlike remote_visible's 0: ALTER TABLE back-fills every
    // existing row with the default, and the AI popup was already on for all
    // of them. A 0 default would silently switch the feature off for every
    // session the user already had.
    { name: 'ai_popup_enabled', ddl: 'ALTER TABLE sessions ADD COLUMN ai_popup_enabled INTEGER DEFAULT 1' },
  ];
  for (const col of ADDED_COLUMNS) {
    if (existing.has(col.name)) continue;
    db.exec(col.ddl);
    log.info('db', `Schema migration: added sessions.${col.name}`);
  }
} catch (err: unknown) {
  log.warn('db', `Sessions column migration skipped: ${err instanceof Error ? err.message : String(err)}`);
}

// ---- One-time data cleanup: sanitize contaminated model ids ----
// Older sessions (and the forks/popups that inherited from them) stored a model
// polluted with a stripped ANSI bold escape, e.g. "claude-opus-4-8[1m]". That
// value broke the unquoted `--model` launch flag — zsh treats `[1m]` as a glob
// ("no matches found"), so popup/fork spawning failed. Clean them in place so
// existing sessions launch and display correctly. See sanitizeModelId (config.ts).
// A second contamination shape stored the WHOLE launch command in `model` (the
// old connecting→idle shortcut for hookless CLIs), e.g.
// "/opt/homebrew/…/bin/codex --dangerously-bypass-approvals-and-sandbox". Those
// rows are matched by the space/slash clauses and reduced to the command's real
// `--model` id, or cleared when it pins none — never to the binary name, which
// would come back as an invalid `--model codex` on the next fork/resume.
try {
  const dirty = db
    .prepare(
      `SELECT id, model FROM sessions
       WHERE model LIKE '%[%' OR model LIKE '%' || char(27) || '%' OR model LIKE '%' || char(10) || '%'
          OR model LIKE '% %' OR model LIKE '%/%'`,
    )
    .all() as Array<{ id: string; model: string }>;
  if (dirty.length > 0) {
    const upd = db.prepare('UPDATE sessions SET model = ? WHERE id = ?');
    const clean = (model: string): string =>
      /[\s/]/.test(model) ? extractModelFromCommand(model) : sanitizeModelId(model);
    const fixAll = db.transaction((rows: Array<{ id: string; model: string }>) => {
      for (const row of rows) upd.run(clean(row.model), row.id);
    });
    fixAll(dirty);
    log.info('db', `Sanitized ${dirty.length} contaminated session model id(s)`);
  }
} catch (err: unknown) {
  log.warn('db', `Model sanitize migration skipped: ${err instanceof Error ? err.message : String(err)}`);
}

// ---- Prepared Statements ----

const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, project_path, project_name, title, model, status, source, summary, remark, team_id, team_role, character_model, accent_color, started_at, ended_at, last_activity_at, total_prompts, total_tool_calls, archived)
    VALUES (@id, @project_path, @project_name, @title, @model, @status, @source, @summary, @remark, @team_id, @team_role, @character_model, @accent_color, @started_at, @ended_at, @last_activity_at, @total_prompts, @total_tool_calls, @archived)
    ON CONFLICT(id) DO UPDATE SET
      project_path = @project_path, project_name = @project_name, title = @title,
      model = @model, status = @status, source = @source,
      summary = @summary, remark = @remark, team_id = @team_id, team_role = @team_role,
      character_model = @character_model, accent_color = @accent_color,
      ended_at = @ended_at, last_activity_at = @last_activity_at,
      total_prompts = @total_prompts, total_tool_calls = @total_tool_calls, archived = @archived
  `),

  insertPrompt: db.prepare(`
    INSERT OR IGNORE INTO prompts (session_id, text, timestamp) VALUES (?, ?, ?)
  `),

  insertResponse: db.prepare(`
    INSERT OR IGNORE INTO responses (session_id, text_excerpt, timestamp) VALUES (?, ?, ?)
  `),

  insertToolCall: db.prepare(`
    INSERT OR IGNORE INTO tool_calls (session_id, tool_name, tool_input_summary, timestamp) VALUES (?, ?, ?, ?)
  `),

  insertEvent: db.prepare(`
    INSERT INTO events (session_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)
  `),

  insertNote: db.prepare(`
    INSERT INTO notes (session_id, text, created_at, updated_at) VALUES (?, ?, ?, ?)
  `),

  // Queries
  getSessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  getAllSessions: db.prepare('SELECT * FROM sessions ORDER BY last_activity_at DESC'),
  getSessionsByProjectPath: db.prepare('SELECT * FROM sessions WHERE project_path = ? ORDER BY last_activity_at DESC'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  updateSessionArchived: db.prepare('UPDATE sessions SET archived = ? WHERE id = ?'),
  updateSessionSummary: db.prepare('UPDATE sessions SET summary = ? WHERE id = ?'),
  updateSessionRemark: db.prepare('UPDATE sessions SET remark = ? WHERE id = ?'),
  updateSessionTitle: db.prepare('UPDATE sessions SET title = ? WHERE id = ?'),

  getPromptsBySession: db.prepare('SELECT * FROM prompts WHERE session_id = ? ORDER BY timestamp ASC'),
  getResponsesBySession: db.prepare('SELECT * FROM responses WHERE session_id = ? ORDER BY timestamp ASC'),
  getToolCallsBySession: db.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC'),
  getEventsBySession: db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC'),
  getNotesBySession: db.prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY created_at DESC'),
  getNoteById: db.prepare('SELECT * FROM notes WHERE id = ?'),
  updateNoteText: db.prepare('UPDATE notes SET text = ?, updated_at = ? WHERE id = ?'),
  deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),

  insertNoteMedia: db.prepare(`
    INSERT INTO note_media (id, session_id, name, mime, ext, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getNoteMediaById: db.prepare('SELECT * FROM note_media WHERE id = ?'),
  getNoteMediaOlderThan: db.prepare('SELECT * FROM note_media WHERE created_at < ?'),
  getNoteMediaBySession: db.prepare('SELECT * FROM note_media WHERE session_id = ?'),
  deleteNoteMediaById: db.prepare('DELETE FROM note_media WHERE id = ?'),

  // ---- Shared per-session prompt queue ----
  getSessionQueue: db.prepare('SELECT * FROM session_queues WHERE session_id = ?'),
  getAllSessionQueues: db.prepare('SELECT * FROM session_queues'),
  upsertSessionQueue: db.prepare(`
    INSERT INTO session_queues (session_id, items, automation, updated_at)
    VALUES (@session_id, @items, @automation, @updated_at)
    ON CONFLICT(session_id) DO UPDATE SET
      items = @items, automation = @automation, updated_at = @updated_at
  `),
  deleteSessionQueue: db.prepare('DELETE FROM session_queues WHERE session_id = ?'),
  // Reference check for the orphan sweep. Deliberately NOT session-scoped: note
  // text can be copy-pasted between sessions, and deleting media still shown
  // somewhere is worse than keeping a few extra bytes.
  countNotesReferencing: db.prepare(
    "SELECT COUNT(*) AS n FROM notes WHERE text LIKE '%' || ? || '%'",
  ),

  // Cascade delete helpers
  deletePromptsBySession: db.prepare('DELETE FROM prompts WHERE session_id = ?'),
  deleteResponsesBySession: db.prepare('DELETE FROM responses WHERE session_id = ?'),
  deleteToolCallsBySession: db.prepare('DELETE FROM tool_calls WHERE session_id = ?'),
  deleteEventsBySession: db.prepare('DELETE FROM events WHERE session_id = ?'),
  deleteNotesBySession: db.prepare('DELETE FROM notes WHERE session_id = ?'),

  // Search
  searchPrompts: db.prepare(`SELECT p.*, s.project_name FROM prompts p JOIN sessions s ON p.session_id = s.id WHERE p.text LIKE ? ORDER BY p.timestamp DESC LIMIT ? OFFSET ?`),
  searchResponses: db.prepare(`SELECT r.*, s.project_name FROM responses r JOIN sessions s ON r.session_id = s.id WHERE r.text_excerpt LIKE ? ORDER BY r.timestamp DESC LIMIT ? OFFSET ?`),
  countSearchPrompts: db.prepare('SELECT COUNT(*) as cnt FROM prompts WHERE text LIKE ?'),
  countSearchResponses: db.prepare('SELECT COUNT(*) as cnt FROM responses WHERE text_excerpt LIKE ?'),

  // Analytics
  distinctProjects: db.prepare(`SELECT DISTINCT project_path, project_name FROM sessions WHERE project_path IS NOT NULL AND project_path != '' ORDER BY project_name`),

  // Agenda tasks
  upsertAgendaTask: db.prepare(`
    INSERT INTO agenda_tasks (id, title, description, priority, tags, due_date, completed, completed_at, created_at, updated_at)
    VALUES (@id, @title, @description, @priority, @tags, @due_date, @completed, @completed_at, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      title = @title, description = @description, priority = @priority, tags = @tags,
      due_date = @due_date, completed = @completed, completed_at = @completed_at, updated_at = @updated_at
  `),
  getAllAgendaTasks: db.prepare('SELECT * FROM agenda_tasks ORDER BY created_at DESC'),
  getAgendaTasksByCompleted: db.prepare('SELECT * FROM agenda_tasks WHERE completed = ? ORDER BY created_at DESC'),
  getAgendaTaskById: db.prepare('SELECT * FROM agenda_tasks WHERE id = ?'),
  deleteAgendaTask: db.prepare('DELETE FROM agenda_tasks WHERE id = ?'),
};

// Batch insert transaction for persisting full session state
const persistSessionTx = db.transaction((session: Session) => {
  stmts.upsertSession.run({
    id: session.sessionId,
    project_path: session.projectPath || '',
    project_name: session.projectName || '',
    title: session.title || '',
    model: session.model || '',
    status: session.status || '',
    source: session.source || 'hook',
    summary: session.summary || null,
    // Safe to include in the ON CONFLICT set above BECAUSE this writes the
    // in-memory session's own value — a hook upsert re-writes the same remark
    // rather than blanking it. That holds only while `remark` is preserved on
    // the in-memory session across re-keys (see reKeyResumedSession) — if a
    // code path ever rebuilds a Session without it, this silently erases the
    // user's note on the next hook event.
    remark: session.remark || null,
    team_id: session.teamId || null,
    team_role: session.teamRole || null,
    character_model: session.characterModel || null,
    accent_color: session.accentColor || null,
    started_at: session.startedAt || null,
    ended_at: session.endedAt || null,
    last_activity_at: session.lastActivityAt || null,
    total_prompts: session.promptHistory?.length || 0,
    total_tool_calls: session.totalToolCalls || 0,
    archived: session.archived || 0,
  });

  if (session.promptHistory?.length) {
    for (const p of session.promptHistory) {
      stmts.insertPrompt.run(session.sessionId, p.text, p.timestamp);
    }
  }

  if (session.responseLog?.length) {
    for (const r of session.responseLog) {
      stmts.insertResponse.run(session.sessionId, r.text, r.timestamp);
    }
  }

  if (session.toolLog?.length) {
    for (const t of session.toolLog) {
      stmts.insertToolCall.run(session.sessionId, t.tool, t.input, t.timestamp);
    }
  }

  if (session.events?.length) {
    for (const e of session.events) {
      stmts.insertEvent.run(session.sessionId, e.type, e.detail || '', e.timestamp);
    }
  }
});

// ---- Exports: Session CRUD ----

/** Upsert a full session with all child records (prompts, responses, tools, events). */
export function upsertSession(session: Session): void {
  try {
    persistSessionTx(session);
  } catch (err: unknown) {
    log.warn('db', `Failed to upsert session ${session.sessionId}: ${(err as Error).message}`);
  }
}

/** Get a single session by ID with all child records. */
export function getSessionDetail(id: string): SessionDetailResponse | null {
  const session = stmts.getSessionById.get(id) as DbSessionRow | undefined;
  if (!session) return null;
  return {
    session,
    prompts: stmts.getPromptsBySession.all(id) as DbPromptRow[],
    responses: stmts.getResponsesBySession.all(id) as DbResponseRow[],
    tool_calls: stmts.getToolCallsBySession.all(id) as DbToolCallRow[],
    events: stmts.getEventsBySession.all(id) as DbEventRow[],
    notes: stmts.getNotesBySession.all(id) as DbNoteRow[],
  };
}

/**
 * Persist one prompt at full length.
 *
 * The in-memory `promptHistory` is capped and may truncate long prompts
 * (`server/sessionTrim.ts`), and `upsertSession` re-inserts from that capped
 * copy — so this must be called with the ORIGINAL text *before* the trimmed
 * entry is pushed. `insertPrompt` is `INSERT OR IGNORE` against
 * `UNIQUE(session_id, timestamp)`, so the full row written here wins and the
 * later truncated re-insert is ignored. Pass the same timestamp used for the
 * in-memory entry or the dedup key won't match and you'll store both.
 */
export function insertFullPrompt(sessionId: string, text: string, timestamp: number): void {
  try {
    stmts.insertPrompt.run(sessionId, text, timestamp);
  } catch {
    // Non-fatal: the capped copy still reaches the DB via upsertSession.
  }
}

/** Return persisted prompts for a session — used to restore promptHistory after a server clear-all. */
export function getPromptsForSession(id: string): Array<{ text: string; timestamp: number }> {
  return (stmts.getPromptsBySession.all(id) as DbPromptRow[]).map((r) => ({
    text: r.text ?? '',
    timestamp: r.timestamp ?? 0,
  }));
}

export function getSessionsByProjectPath(projectPath: string): DbSessionRow[] {
  return stmts.getSessionsByProjectPath.all(projectPath) as DbSessionRow[];
}

export function getAllPersistedSessions(): DbSessionRow[] {
  return stmts.getAllSessions.all() as DbSessionRow[];
}

/** Cascade-delete a session and all child records. */
export const deleteSessionCascade: (id: string) => void = db.transaction((id: string) => {
  stmts.deletePromptsBySession.run(id);
  stmts.deleteResponsesBySession.run(id);
  stmts.deleteToolCallsBySession.run(id);
  stmts.deleteEventsBySession.run(id);
  stmts.deleteNotesBySession.run(id);
  // The shared queue has no FK to sessions (it is written before a session row
  // may exist), so it would otherwise outlive the session forever.
  stmts.deleteSessionQueue.run(id);
  stmts.deleteSession.run(id);
});

export function updateSessionArchived(id: string, archived: boolean | number): void {
  stmts.updateSessionArchived.run(archived ? 1 : 0, id);
}

export function updateSessionSummary(id: string, summary: string | null): void {
  stmts.updateSessionSummary.run(summary || null, id);
}

/** Persist the user's progress remark. Empty string clears it (stored NULL). */
export function updateSessionRemark(id: string, remark: string | null): void {
  stmts.updateSessionRemark.run(remark || null, id);
}

export function updateSessionTitle(id: string, title: string): void {
  stmts.updateSessionTitle.run(title || '', id);
}

// ---- Notes ----

export function getNotes(sessionId: string): DbNoteRow[] {
  return stmts.getNotesBySession.all(sessionId) as DbNoteRow[];
}

export function addNote(sessionId: string, text: string): DbNoteRow {
  const now = Date.now();
  const info = stmts.insertNote.run(sessionId, text, now, now);
  return { id: Number(info.lastInsertRowid), session_id: sessionId, text, created_at: now, updated_at: now };
}

/** Update a note's text, bumping `updated_at`. Returns null if the id is unknown. */
export function updateNote(id: number, text: string): DbNoteRow | null {
  const now = Date.now();
  const info = stmts.updateNoteText.run(text, now, id);
  if (info.changes === 0) return null;
  return (stmts.getNoteById.get(id) as DbNoteRow | undefined) ?? null;
}

export function deleteNote(id: number): void {
  stmts.deleteNote.run(id);
}

// ---- Note media (metadata only — bytes live on disk, see noteMedia.ts) ----

export interface DbNoteMediaRow {
  id: string;
  session_id: string;
  name: string | null;
  mime: string;
  ext: string;
  bytes: number;
  created_at: number;
}

export function addNoteMedia(row: DbNoteMediaRow): DbNoteMediaRow {
  stmts.insertNoteMedia.run(
    row.id, row.session_id, row.name, row.mime, row.ext, row.bytes, row.created_at,
  );
  return row;
}

export function getNoteMedia(id: string): DbNoteMediaRow | null {
  return (stmts.getNoteMediaById.get(id) as DbNoteMediaRow | undefined) ?? null;
}

export function getNoteMediaOlderThan(cutoff: number): DbNoteMediaRow[] {
  return stmts.getNoteMediaOlderThan.all(cutoff) as DbNoteMediaRow[];
}

export function getNoteMediaBySession(sessionId: string): DbNoteMediaRow[] {
  return stmts.getNoteMediaBySession.all(sessionId) as DbNoteMediaRow[];
}

export function deleteNoteMediaRow(id: string): void {
  stmts.deleteNoteMediaById.run(id);
}

// ---- Shared per-session prompt queue -------------------------------------
//
// The server stores these as opaque JSON and never inspects them — see the
// `session_queues` table comment for why that is deliberate rather than lazy.

export function getSessionQueue(sessionId: string): SessionQueueRecord | null {
  return decodeQueueRow(stmts.getSessionQueue.get(sessionId) as SessionQueueRow | undefined);
}

/** Every stored queue, for a client's one-shot hydration on connect. */
export function getAllSessionQueues(): SessionQueueRecord[] {
  const rows = stmts.getAllSessionQueues.all() as SessionQueueRow[];
  return rows.map(decodeQueueRow).filter((r): r is SessionQueueRecord => r !== null);
}

export function upsertSessionQueue(
  sessionId: string,
  items: unknown[],
  automation: unknown | null,
): SessionQueueRecord {
  const updatedAt = Date.now();
  const encoded = encodeQueue(items, automation);
  stmts.upsertSessionQueue.run({
    session_id: sessionId,
    items: encoded.items,
    automation: encoded.automation,
    updated_at: updatedAt,
  });
  return { sessionId, items, automation: automation ?? null, updatedAt };
}

export function deleteSessionQueue(sessionId: string): void {
  stmts.deleteSessionQueue.run(sessionId);
}

/** True when any note's text still embeds this media id. */
export function isNoteMediaReferenced(id: string): boolean {
  const row = stmts.countNotesReferencing.get(id) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

// ---- Search ----

export function searchSessions(params: SessionSearchParams = {}): SessionSearchResponse {
  const { query, project, status, dateFrom, dateTo, archived, sortBy = 'started_at', sortDir = 'desc', page = 1, pageSize = 50 } = params;
  const conditions: string[] = [];
  const sqlParams: unknown[] = [];

  if (project) { conditions.push('project_path = ?'); sqlParams.push(project); }
  if (status) { conditions.push('status = ?'); sqlParams.push(status); }
  if (dateFrom) { conditions.push('started_at >= ?'); sqlParams.push(dateFrom); }
  if (dateTo) { conditions.push('started_at <= ?'); sqlParams.push(dateTo); }
  if (archived === true || archived === 'true' || archived === 1) {
    conditions.push('archived = 1');
  } else if (archived !== 'all') {
    conditions.push('(archived = 0 OR archived IS NULL)');
  }

  // Text search in prompts
  if (query) {
    conditions.push(`id IN (SELECT DISTINCT session_id FROM prompts WHERE text LIKE ?)`);
    sqlParams.push(`%${query}%`);
  }

  // The column name is interpolated into ORDER BY, so it must come from this
  // whitelist. total_prompts / total_tool_calls back the HISTORY tab's "Prompts"
  // and "Tools" sorts, which silently fell back to started_at before Oct 2026.
  const allowedSort = ['started_at', 'last_activity_at', 'project_name', 'status', 'total_prompts', 'total_tool_calls'];
  // Interpolate OUR literal, never the request value — safe even if the
  // comparison is ever loosened (a prefix match would otherwise pass
  // `total_prompts, (SELECT …)` straight into the SQL).
  const col = allowedSort.find((c) => c === sortBy) ?? 'started_at';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*) as cnt FROM sessions ${where}`;
  // `id` breaks ties (many sessions share a prompt/tool count), so LIMIT/OFFSET
  // pages are a total order and never repeat or skip a row.
  const dataSql = `SELECT * FROM sessions ${where} ORDER BY ${col} ${dir}, id ${dir} LIMIT ? OFFSET ?`;

  const offset = ((page || 1) - 1) * (pageSize || 50);
  const total = (db.prepare(countSql).get(...sqlParams) as { cnt: number }).cnt;
  const sessions = db.prepare(dataSql).all(...sqlParams, pageSize || 50, offset) as DbSessionRow[];

  return { sessions, total, page: page || 1, pageSize: pageSize || 50 };
}

export function fullTextSearch(params: { query?: string; type?: string; page?: number; pageSize?: number } = {}): FullTextSearchResponse {
  const { query, type = 'all', page = 1, pageSize = 50 } = params;
  if (!query) return { results: [], total: 0, page, pageSize };
  const pattern = `%${query}%`;
  const offset = (page - 1) * pageSize;
  const results: FullTextSearchResult[] = [];

  if (type === 'all' || type === 'prompts') {
    const rows = stmts.searchPrompts.all(pattern, pageSize, offset) as Array<DbPromptRow & { project_name: string }>;
    for (const r of rows) {
      results.push({ session_id: r.session_id, project_name: r.project_name, type: 'prompt', text: r.text, timestamp: r.timestamp });
    }
  }

  if (type === 'all' || type === 'responses') {
    const rows = stmts.searchResponses.all(pattern, pageSize, offset) as Array<DbResponseRow & { project_name: string }>;
    for (const r of rows) {
      results.push({ session_id: r.session_id, project_name: r.project_name, type: 'response', text: r.text_excerpt, timestamp: r.timestamp });
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);

  let total = 0;
  if (type === 'all' || type === 'prompts') total += (stmts.countSearchPrompts.get(pattern) as { cnt: number }).cnt;
  if (type === 'all' || type === 'responses') total += (stmts.countSearchResponses.get(pattern) as { cnt: number }).cnt;

  return { results: results.slice(0, pageSize), total, page, pageSize };
}

// ---- Prompt trace (global record of every prompt sent) ----

/**
 * Harness/agent-injected turns. They arrive through the same `UserPromptSubmit`
 * hook as real prompts (`<task-notification>`, `<observed_from_primary_session>`,
 * `<system-reminder>`, `<agent-message …>`, `<<autonomous-loop-dynamic>>`), and
 * every known form opens with `<` — so one generic predicate covers today's
 * tags and whatever the harness adds next, instead of a list that silently
 * rots. `ltrim` because a leading newline is common.
 */
/**
 * SQLite's bare `ltrim(X)`/`trim(X)` strip SPACES ONLY — a leading newline is
 * left in place, which silently classified `"\n  <observed_from_primary_session>"`
 * as something the user typed. Every trim below passes this charset explicitly.
 */
const WS_CHARS = `' ' || char(9) || char(10) || char(13)`;
const LTRIMMED_TEXT = `ltrim(p.text, ${WS_CHARS})`;

const AGENT_PROMPT_SQL = `${LTRIMMED_TEXT} LIKE '<%'`;
/** Slash commands, plus Codex's `$SkillName` form (see `entryPrefix`). */
const COMMAND_PROMPT_SQL = `(${LTRIMMED_TEXT} LIKE '/%' OR ${LTRIMMED_TEXT} LIKE '$%')`;
/** A blank row is not a prompt; only the unfiltered `all` facet shows them. */
const NON_BLANK_SQL = `trim(coalesce(p.text, ''), ${WS_CHARS}) <> ''`;

/**
 * Escape LIKE wildcards in user input. Without this, searching for `50%` or
 * `foo_bar` silently matches far more than the user asked for.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function kindCondition(kind: PromptKind): string | null {
  switch (kind) {
    case 'agent': return AGENT_PROMPT_SQL;
    case 'cmd': return `NOT (${AGENT_PROMPT_SQL}) AND ${COMMAND_PROMPT_SQL} AND ${NON_BLANK_SQL}`;
    case 'all': return null;
    case 'mine':
    default: return `NOT (${AGENT_PROMPT_SQL}) AND ${NON_BLANK_SQL}`;
  }
}

/**
 * Paginated search over every prompt ever recorded, joined to its session.
 *
 * LEFT JOIN, deliberately. better-sqlite3 turns `PRAGMA foreign_keys` ON by
 * default, so today `prompts.session_id` always resolves and an inner join
 * would behave identically — but this is the one view whose job is to never
 * lose a prompt, and an inner join makes "the session row went missing" mean
 * "the prompt never existed". (The older `fullTextSearch` joins inner and would
 * drop them.) Callers must therefore treat the session columns as nullable.
 */
export function searchPrompts(params: PromptSearchParams = {}): PromptSearchResponse {
  const {
    query, project, session, kind = 'mine', dateFrom, dateTo,
    sortDir = 'desc', page = 1, pageSize = 50,
  } = params;

  const conditions: string[] = [];
  const sqlParams: unknown[] = [];

  const kindSql = kindCondition(kind);
  if (kindSql) conditions.push(`(${kindSql})`);

  if (query) {
    conditions.push(`p.text LIKE ? ESCAPE '\\'`);
    sqlParams.push(`%${escapeLike(query)}%`);
  }
  if (project) { conditions.push('s.project_path = ?'); sqlParams.push(project); }
  if (session) { conditions.push('p.session_id = ?'); sqlParams.push(session); }
  if (dateFrom) { conditions.push('p.timestamp >= ?'); sqlParams.push(dateFrom); }
  if (dateTo) { conditions.push('p.timestamp <= ?'); sqlParams.push(dateTo); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = 'FROM prompts p LEFT JOIN sessions s ON p.session_id = s.id';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;

  try {
    const total = (db.prepare(`SELECT COUNT(*) AS cnt ${from} ${where}`).get(...sqlParams) as { cnt: number }).cnt;
    const prompts = db.prepare(`
      SELECT p.id, p.session_id, p.text, p.timestamp,
             s.project_name, s.project_path, s.title AS session_title
      ${from} ${where}
      ORDER BY p.timestamp ${dir}, p.id ${dir}
      LIMIT ? OFFSET ?
    `).all(...sqlParams, pageSize, offset) as PromptTraceRow[];
    return { prompts, total, page, pageSize };
  } catch (err: unknown) {
    log.warn('db', `searchPrompts failed: ${(err as Error).message}`);
    return { prompts: [], total: 0, page, pageSize };
  }
}

// ---- Analytics ----

export function getDistinctProjects(): DistinctProject[] {
  return stmts.distinctProjects.all() as DistinctProject[];
}

// ---- Agenda Tasks ----

interface AgendaTaskRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  tags: string;
  due_date: string | null;
  completed: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAgendaTask(row: AgendaTaskRow): AgendaTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    priority: row.priority as AgendaTask['priority'],
    tags: JSON.parse(row.tags) as string[],
    dueDate: row.due_date ?? undefined,
    completed: row.completed === 1,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllAgendaTasks(completed?: boolean): AgendaTask[] {
  const rows = completed === undefined
    ? stmts.getAllAgendaTasks.all() as AgendaTaskRow[]
    : stmts.getAgendaTasksByCompleted.all(completed ? 1 : 0) as AgendaTaskRow[];
  return rows.map(rowToAgendaTask);
}

export function getAgendaTaskById(id: string): AgendaTask | null {
  const row = stmts.getAgendaTaskById.get(id) as AgendaTaskRow | undefined;
  return row ? rowToAgendaTask(row) : null;
}

export function upsertAgendaTask(task: AgendaTask): void {
  stmts.upsertAgendaTask.run({
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    priority: task.priority,
    tags: JSON.stringify(task.tags),
    due_date: task.dueDate ?? null,
    completed: task.completed ? 1 : 0,
    completed_at: task.completedAt ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  });
}

export function deleteAgendaTask(id: string): void {
  stmts.deleteAgendaTask.run(id);
}

// ---- Session ID migration ----

export const migrateSessionId: (oldId: string, newId: string) => void = db.transaction((oldId: string, newId: string) => {
  if (oldId === newId) return;
  db.prepare('UPDATE prompts SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  db.prepare('UPDATE responses SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  db.prepare('UPDATE tool_calls SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  db.prepare('UPDATE events SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  db.prepare('UPDATE notes SET session_id = ? WHERE session_id = ?').run(newId, oldId);

  // Resolve the parent `sessions` row too — without this the old row is
  // orphaned in history (stale status, ever-growing duration, 0 prompts/tools
  // because the child records above just moved to newId). If the new row
  // already exists (the upsert-then-migrate path), drop the old one; otherwise
  // rename the old row in place so no session row is ever lost.
  const newExists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(newId);
  if (newExists) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(oldId);
  } else {
    db.prepare('UPDATE sessions SET id = ? WHERE id = ?').run(newId, oldId);
  }
});

/**
 * Heal stale "live" session rows left over from a previous run. Any row that is
 * not already ended is from a process that has since died — without this its
 * History status stays frozen (idle/working/…) and its computed duration grows
 * forever (now − started_at). Marks them ended and stamps ended_at from the best
 * available timestamp. Returns the number of rows healed. Idempotent.
 */
export function markStaleSessionsEnded(): number {
  const info = db.prepare(`
    UPDATE sessions
    SET status = 'ended',
        ended_at = COALESCE(ended_at, last_activity_at, started_at)
    WHERE status != 'ended'
  `).run();
  return info.changes;
}

// ---- Shutdown ----

export function closeDb(): void {
  try {
    db.close();
    log.info('db', 'SQLite database closed');
  } catch (err: unknown) {
    log.warn('db', `Failed to close database: ${(err as Error).message}`);
  }
}
