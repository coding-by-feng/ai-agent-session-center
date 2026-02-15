// @ts-check
// db.js — SQLite persistence layer for all session data
// Stores sessions, prompts, responses, tool calls, events, and notes in data/sessions.db
// so all browsers (localhost, LAN IP, etc.) see the same data.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import log from './logger.js';

const __dbDirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dbDirname, '..', 'data');
const DB_PATH = join(DB_DIR, 'sessions.db');

mkdirSync(DB_DIR, { recursive: true });

/** @type {import('better-sqlite3').Database} */
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
`);

log.info('db', `SQLite database opened: ${DB_PATH}`);

// ---- Prepared Statements ----

const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, project_path, project_name, title, model, status, source, label, summary, team_id, team_role, character_model, accent_color, started_at, ended_at, last_activity_at, total_prompts, total_tool_calls, archived)
    VALUES (@id, @project_path, @project_name, @title, @model, @status, @source, @label, @summary, @team_id, @team_role, @character_model, @accent_color, @started_at, @ended_at, @last_activity_at, @total_prompts, @total_tool_calls, @archived)
    ON CONFLICT(id) DO UPDATE SET
      project_path = @project_path, project_name = @project_name, title = @title,
      model = @model, status = @status, source = @source, label = @label,
      summary = @summary, team_id = @team_id, team_role = @team_role,
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
  updateSessionTitle: db.prepare('UPDATE sessions SET title = ? WHERE id = ?'),
  updateSessionLabel: db.prepare('UPDATE sessions SET label = ? WHERE id = ?'),

  getPromptsBySession: db.prepare('SELECT * FROM prompts WHERE session_id = ? ORDER BY timestamp ASC'),
  getResponsesBySession: db.prepare('SELECT * FROM responses WHERE session_id = ? ORDER BY timestamp ASC'),
  getToolCallsBySession: db.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC'),
  getEventsBySession: db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC'),
  getNotesBySession: db.prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY created_at DESC'),
  deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),

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
  summaryStats: db.prepare(`SELECT COUNT(*) as total_sessions, SUM(CASE WHEN status != 'ended' THEN 1 ELSE 0 END) as active_sessions FROM sessions`),
  totalPrompts: db.prepare('SELECT COUNT(*) as cnt FROM prompts'),
  totalToolCalls: db.prepare('SELECT COUNT(*) as cnt FROM tool_calls'),
  toolBreakdown: db.prepare(`SELECT tool_name, COUNT(*) as count FROM tool_calls GROUP BY tool_name ORDER BY count DESC`),
  activeProjects: db.prepare(`
    SELECT s.project_path, s.project_name,
      COUNT(DISTINCT s.id) as session_count,
      MAX(s.last_activity_at) as last_activity
    FROM sessions s
    WHERE s.project_path IS NOT NULL AND s.project_path != ''
    GROUP BY s.project_path
    ORDER BY last_activity DESC
  `),
};

// Batch insert transaction for persisting full session state
const persistSessionTx = db.transaction((session) => {
  stmts.upsertSession.run({
    id: session.sessionId,
    project_path: session.projectPath || '',
    project_name: session.projectName || '',
    title: session.title || '',
    model: session.model || '',
    status: session.status || '',
    source: session.source || 'hook',
    label: session.label || null,
    summary: session.summary || null,
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
export function upsertSession(session) {
  try {
    persistSessionTx(session);
  } catch (err) {
    log.warn('db', `Failed to upsert session ${session.sessionId}: ${err.message}`);
  }
}

/** Get a single session by ID with all child records. */
export function getSessionDetail(id) {
  const session = stmts.getSessionById.get(id);
  if (!session) return null;
  return {
    session,
    prompts: stmts.getPromptsBySession.all(id),
    responses: stmts.getResponsesBySession.all(id),
    tool_calls: stmts.getToolCallsBySession.all(id),
    events: stmts.getEventsBySession.all(id),
    notes: stmts.getNotesBySession.all(id),
  };
}

export function getSessionsByProjectPath(projectPath) {
  return stmts.getSessionsByProjectPath.all(projectPath);
}

export function getAllPersistedSessions() {
  return stmts.getAllSessions.all();
}

/** Cascade-delete a session and all child records. */
export const deleteSessionCascade = db.transaction((id) => {
  stmts.deletePromptsBySession.run(id);
  stmts.deleteResponsesBySession.run(id);
  stmts.deleteToolCallsBySession.run(id);
  stmts.deleteEventsBySession.run(id);
  stmts.deleteNotesBySession.run(id);
  stmts.deleteSession.run(id);
});

export function updateSessionArchived(id, archived) {
  stmts.updateSessionArchived.run(archived ? 1 : 0, id);
}

export function updateSessionSummary(id, summary) {
  stmts.updateSessionSummary.run(summary || null, id);
}

export function updateSessionTitle(id, title) {
  stmts.updateSessionTitle.run(title || '', id);
}

export function updateSessionLabel(id, label) {
  stmts.updateSessionLabel.run(label || null, id);
}

// ---- Notes ----

export function getNotes(sessionId) {
  return stmts.getNotesBySession.all(sessionId);
}

export function addNote(sessionId, text) {
  const now = Date.now();
  const info = stmts.insertNote.run(sessionId, text, now, now);
  return { id: info.lastInsertRowid, session_id: sessionId, text, created_at: now, updated_at: now };
}

export function deleteNote(id) {
  stmts.deleteNote.run(id);
}

// ---- Search ----

export function searchSessions({ query, project, status, dateFrom, dateTo, archived, sortBy = 'started_at', sortDir = 'desc', page = 1, pageSize = 50 } = {}) {
  const conditions = [];
  const params = [];

  if (project) { conditions.push('project_path = ?'); params.push(project); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (dateFrom) { conditions.push('started_at >= ?'); params.push(dateFrom); }
  if (dateTo) { conditions.push('started_at <= ?'); params.push(dateTo); }
  if (archived === true || archived === 'true' || archived === 1) {
    conditions.push('archived = 1');
  } else if (archived !== 'all') {
    conditions.push('(archived = 0 OR archived IS NULL)');
  }

  // Text search in prompts
  if (query) {
    conditions.push(`id IN (SELECT DISTINCT session_id FROM prompts WHERE text LIKE ?)`);
    params.push(`%${query}%`);
  }

  const allowedSort = ['started_at', 'last_activity_at', 'project_name', 'status'];
  const col = allowedSort.includes(sortBy) ? sortBy : 'started_at';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*) as cnt FROM sessions ${where}`;
  const dataSql = `SELECT * FROM sessions ${where} ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`;

  const offset = (page - 1) * pageSize;
  const total = db.prepare(countSql).get(...params).cnt;
  const sessions = db.prepare(dataSql).all(...params, pageSize, offset);

  return { sessions, total, page, pageSize };
}

export function fullTextSearch({ query, type = 'all', page = 1, pageSize = 50 } = {}) {
  if (!query) return { results: [], total: 0, page, pageSize };
  const pattern = `%${query}%`;
  const offset = (page - 1) * pageSize;
  const results = [];

  if (type === 'all' || type === 'prompts') {
    const rows = stmts.searchPrompts.all(pattern, pageSize, offset);
    for (const r of rows) {
      results.push({ session_id: r.session_id, project_name: r.project_name, type: 'prompt', text: r.text, timestamp: r.timestamp });
    }
  }

  if (type === 'all' || type === 'responses') {
    const rows = stmts.searchResponses.all(pattern, pageSize, offset);
    for (const r of rows) {
      results.push({ session_id: r.session_id, project_name: r.project_name, type: 'response', text: r.text_excerpt, timestamp: r.timestamp });
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);

  let total = 0;
  if (type === 'all' || type === 'prompts') total += stmts.countSearchPrompts.get(pattern).cnt;
  if (type === 'all' || type === 'responses') total += stmts.countSearchResponses.get(pattern).cnt;

  return { results: results.slice(0, pageSize), total, page, pageSize };
}

// ---- Analytics ----

export function getDistinctProjects() {
  return stmts.distinctProjects.all();
}

export function getSummaryStats() {
  const stats = stmts.summaryStats.get();
  const promptCount = stmts.totalPrompts.get().cnt;
  const toolCount = stmts.totalToolCalls.get().cnt;

  const tools = stmts.toolBreakdown.all();
  const mostUsedTool = tools.length > 0 ? { tool_name: tools[0].tool_name, count: tools[0].count } : null;

  const projects = stmts.activeProjects.all();
  const busiestProject = projects.length > 0
    ? { project_path: projects[0].project_path, name: projects[0].project_name, count: projects[0].session_count }
    : null;

  return {
    total_sessions: stats.total_sessions,
    active_sessions: stats.active_sessions || 0,
    total_prompts: promptCount,
    total_tool_calls: toolCount,
    most_used_tool: mostUsedTool,
    busiest_project: busiestProject,
  };
}

export function getToolBreakdown() {
  const tools = stmts.toolBreakdown.all();
  const total = tools.reduce((s, t) => s + t.count, 0);
  return tools.map(t => ({
    tool_name: t.tool_name,
    count: t.count,
    percentage: total > 0 ? Math.round(t.count / total * 1000) / 10 : 0,
  }));
}

export function getActiveProjects() {
  return stmts.activeProjects.all();
}

export function getHeatmap() {
  const rows = db.prepare('SELECT timestamp FROM events').all();
  const grid = {};
  for (const { timestamp } of rows) {
    const d = new Date(timestamp);
    const jsDay = d.getDay();
    const day = jsDay === 0 ? 6 : jsDay - 1;
    const hour = d.getHours();
    const key = `${day}-${hour}`;
    grid[key] = (grid[key] || 0) + 1;
  }
  const result = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const key = `${day}-${hour}`;
      if (grid[key]) result.push({ day_of_week: day, hour, count: grid[key] });
    }
  }
  return result;
}

// ---- Session ID migration ----

export const migrateSessionId = db.transaction((oldId, newId) => {
  db.prepare('UPDATE prompts SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  db.prepare('UPDATE responses SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  db.prepare('UPDATE tool_calls SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  db.prepare('UPDATE events SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  db.prepare('UPDATE notes SET session_id = ? WHERE session_id = ?').run(newId, oldId);
});

// ---- Shutdown ----

export function closeDb() {
  try {
    db.close();
    log.info('db', 'SQLite database closed');
  } catch (err) {
    log.warn('db', `Failed to close database: ${err.message}`);
  }
}
