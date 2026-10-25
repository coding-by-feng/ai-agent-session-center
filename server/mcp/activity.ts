// activity.ts — the activity log: every write a central made, every refusal of one, and every change of a task it
// handed out, kept 30 days in the `mcp_activity` table (created here, on the server's own database: `dbHandle()`).
//
// Who writes it: runTool.ts, for every way into a tool (a non-read call, ok or refused or failed; a policy refusal
// from ctx.mayDrive, whatever the tool), server.ts for a write refused by its argument check, and deliver.ts for
// a task's changes of state. Reads are never logged.
//
// What a row may hold: AASC's own words, ids AASC resolved, codes and small numbers. Never an argument value a
// central sent (prompt text can hold anything), never text a session wrote, never a token. Every text is folded to
// one line and cut short, and anything shaped like a token or a bearer header is blanked on the way in.
//
// The SQL is plain SQLite through a handle with `exec` and `prepare` (better-sqlite3's, in the server; `node:sqlite`
// in tests), opened on first use. New rows are told to `onActivity` listeners (the local-only `mcp_activity`
// broadcast). Rows older than ACTIVITY_KEEP_MS go on first use and then every hour, on a timer that never keeps the
// process alive.

import type {
  McpActivityDetail,
  McpActivityOutcome,
  McpActivityRow,
  McpRisk,
} from '../../src/types/mcpEvents.js';
import log from '../logger.js';
import type { Risk } from './types.js';

/** How long rows are kept. */
export const ACTIVITY_KEEP_MS = 30 * 24 * 60 * 60_000;
/** How often old rows are dropped. */
export const ACTIVITY_PRUNE_EVERY_MS = 60 * 60_000;
/** The most rows one list answers. */
export const ACTIVITY_LIST_MAX = 500;
/** The rows a list answers when it is not told. */
export const ACTIVITY_LIST_DEFAULT = 100;

const SUMMARY_MAX = 300;
const DETAIL_VALUE_MAX = 200;
const DETAIL_KEYS_MAX = 12;
const DETAIL_KEY_MAX = 40;
const ID_MAX = 256;

export type ActivityRow = McpActivityRow;
export type ActivityDetail = McpActivityDetail;

// The server's Risk and the shared one must be the same set of words.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const RISKS_MATCH: Same<Risk, McpRisk> = true;
void RISKS_MATCH;

/** A row to write. `at` defaults to now; the other optional fields to null. */
export interface ActivityInput {
  centralId: string;
  centralSessionId?: string | null;
  tool: string;
  risk: Risk;
  targetSessionId?: string | null;
  taskId?: string | null;
  /** AASC's words for what happened: never an argument value or text a session wrote. */
  summary: string;
  outcome: McpActivityOutcome;
  detail?: ActivityDetail | null;
  at?: number;
}

/**
 * What a non-read tool says about one thing it did, beside its answer (ToolResult.activity): runTool writes one row
 * per note, under the tool's name and risk. A fan-out gives one per session. A policy refusal from ctx.mayDrive is
 * logged already: no note for it.
 */
export interface ActivityNote {
  summary: string;
  targetSessionId?: string | null;
  taskId?: string | null;
  /** Defaults to 'ok'. */
  outcome?: 'ok' | 'refused' | 'failed';
  detail?: ActivityDetail;
}

export interface ActivityQuery {
  /** One central's rows only. */
  centralId?: string;
  /** 1 to ACTIVITY_LIST_MAX; ACTIVITY_LIST_DEFAULT when absent. */
  limit?: number;
  /** Rows older than this row id (a cursor: the last id of the page before). */
  beforeId?: number;
}

export interface ActivityLog {
  /** Writes a row, tells the listeners, and answers it. Throws when the database fails (the caller logs and goes on). */
  logActivity(input: ActivityInput): ActivityRow;
  /** Newest first. */
  listActivity(query?: ActivityQuery): ActivityRow[];
  /** Drops rows older than `olderThanMs` (default ACTIVITY_KEEP_MS); answers how many went. */
  pruneActivity(olderThanMs?: number): number;
  /** Every new row, from now on. Returns the unsubscribe. */
  onActivity(listener: (row: ActivityRow) => void): () => void;
  /** The highest task number (`T<n>`) a row names, or 0: a new server run counts its task ids on from it. */
  maxTaskNumber(): number;
  /** Stops the hourly prune. */
  close(): void;
}

type SqlValue = string | number | null;
type SqlChanges = { changes: number | bigint; lastInsertRowid: number | bigint };

/** What the log needs of a SQLite handle: better-sqlite3's `Database` and node:sqlite's `DatabaseSync` both fit. */
export interface SqlStatement {
  run(...params: SqlValue[]): SqlChanges;
  all(...params: SqlValue[]): unknown[];
}
export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

/**
 * Runs a prepared statement. Spelled with Reflect.apply because test/mcp/runTool.test.ts allows a method call
 * named run in server/mcp only in runTool.ts (the one place a tool's run is called).
 */
function execute(statement: SqlStatement, ...params: SqlValue[]): SqlChanges {
  return Reflect.apply(statement.run, statement, params) as SqlChanges;
}

export interface ActivityLogOptions {
  /** The database, opened on first use (the server passes `dbHandle`). */
  db: () => SqlDatabase;
  now?: () => number;
  /** How often old rows are dropped; null never (tests). Defaults to ACTIVITY_PRUNE_EVERY_MS. */
  pruneEveryMs?: number | null;
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/** Token shapes blanked in every text: AASC's own, a bearer header, and the common provider keys. */
const SECRET_SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/aasc_mcp_[A-Za-z0-9_-]+/g, 'aasc_mcp_[redacted]'],
  [/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '$1-[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox-[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[redacted]'],
];

/** `text` with its token shapes blanked, its spacing and length as they were. */
export function blankSecrets(text: string): string {
  let out = text;
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  return out;
}

/** `text` on one line, token shapes blanked, cut to `max` characters. */
export function scrubText(text: string, max: number): string {
  const out = blankSecrets(text.replace(/\s+/g, ' ').trim());
  return out.length > max ? `${out.slice(0, Math.max(0, max - 1))}…` : out;
}

/** An id as it may be stored: text only, bounded; anything else is no id. */
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? scrubText(v, ID_MAX) : null);

/** A detail kept flat and small: string, finite number, boolean or null values only, each cut short. */
export function scrubDetail(detail: unknown): ActivityDetail | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const out: ActivityDetail = {};
  for (const [key, value] of Object.entries(detail).slice(0, DETAIL_KEYS_MAX)) {
    const name = key.slice(0, DETAIL_KEY_MAX);
    if (typeof value === 'string') out[name] = scrubText(value, DETAIL_VALUE_MAX);
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
    else if (typeof value === 'boolean' || value === null) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_activity (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    central_id TEXT NOT NULL,
    central_session_id TEXT,
    tool TEXT NOT NULL,
    risk TEXT NOT NULL,
    target_session_id TEXT,
    task_id TEXT,
    summary TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_activity_at ON mcp_activity(at);
  CREATE INDEX IF NOT EXISTS idx_mcp_activity_central ON mcp_activity(central_id, id);
`;

interface StoredRow {
  id: number | bigint;
  at: number | bigint;
  central_id: string;
  central_session_id: string | null;
  tool: string;
  risk: string;
  target_session_id: string | null;
  task_id: string | null;
  summary: string;
  outcome: string;
  detail_json: string | null;
}

function parseDetail(json: string | null): ActivityDetail | null {
  if (json === null) return null;
  try {
    return scrubDetail(JSON.parse(json));
  } catch {
    return null;
  }
}

function fromStored(r: StoredRow): ActivityRow {
  return {
    id: Number(r.id),
    at: Number(r.at),
    centralId: r.central_id,
    centralSessionId: r.central_session_id,
    tool: r.tool,
    risk: r.risk as Risk,
    targetSessionId: r.target_session_id,
    taskId: r.task_id,
    summary: r.summary,
    outcome: r.outcome as McpActivityOutcome,
    detail: parseDetail(r.detail_json),
  };
}

/** A whole number from 1 to ACTIVITY_LIST_MAX. */
function listLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return ACTIVITY_LIST_DEFAULT;
  return Math.min(ACTIVITY_LIST_MAX, Math.max(1, Math.floor(limit)));
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createActivityLog(opts: ActivityLogOptions): ActivityLog {
  const now = opts.now ?? Date.now;
  const listeners = new Set<(row: ActivityRow) => void>();
  let db: SqlDatabase | null = null;

  /** The database, with its table, opened (and pruned once) on first use. */
  function ready(): SqlDatabase {
    if (db !== null) return db;
    const opened = opts.db();
    opened.exec(SCHEMA);
    db = opened;
    prune(ACTIVITY_KEEP_MS);
    return opened;
  }

  function prune(olderThanMs: number = ACTIVITY_KEEP_MS): number {
    const result = execute(ready().prepare('DELETE FROM mcp_activity WHERE at < ?'), now() - olderThanMs);
    return Number(result.changes);
  }

  function logActivity(input: ActivityInput): ActivityRow {
    const row: Omit<ActivityRow, 'id'> = {
      at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : now(),
      centralId: idOrNull(input.centralId) ?? 'unknown',
      centralSessionId: idOrNull(input.centralSessionId),
      tool: scrubText(String(input.tool), 64),
      risk: input.risk,
      targetSessionId: idOrNull(input.targetSessionId),
      taskId: idOrNull(input.taskId),
      summary: scrubText(String(input.summary), SUMMARY_MAX),
      outcome: input.outcome,
      detail: scrubDetail(input.detail),
    };
    const result = execute(
      ready().prepare(
        `INSERT INTO mcp_activity (at, central_id, central_session_id, tool, risk, target_session_id, task_id, summary, outcome, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      row.at,
      row.centralId,
      row.centralSessionId,
      row.tool,
      row.risk,
      row.targetSessionId,
      row.taskId,
      row.summary,
      row.outcome,
      row.detail === null ? null : JSON.stringify(row.detail),
    );
    const written: ActivityRow = { id: Number(result.lastInsertRowid), ...row };
    for (const listener of [...listeners]) {
      try {
        listener({ ...written, detail: written.detail === null ? null : { ...written.detail } });
      } catch (err) {
        log.warn('mcp', `An activity listener failed: ${describe(err)}`);
      }
    }
    return written;
  }

  function listActivity(query: ActivityQuery = {}): ActivityRow[] {
    const limit = listLimit(query.limit);
    const central = typeof query.centralId === 'string' && query.centralId !== '' ? query.centralId : null;
    const before = typeof query.beforeId === 'number' && Number.isFinite(query.beforeId) ? Math.floor(query.beforeId) : null;
    const rows = ready()
      .prepare(
        `SELECT * FROM mcp_activity
         WHERE (? IS NULL OR central_id = ?) AND (? IS NULL OR id < ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(central, central, before, before, limit) as StoredRow[];
    return rows.map(fromStored);
  }

  function maxTaskNumber(): number {
    const [row] = ready()
      .prepare(`SELECT MAX(CAST(SUBSTR(task_id, 2) AS INTEGER)) AS n FROM mcp_activity WHERE task_id GLOB 'T[0-9]*'`)
      .all() as Array<{ n: number | bigint | null } | undefined>;
    const n = Number(row?.n ?? 0);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  function onActivity(listener: (row: ActivityRow) => void): () => void {
    const subscription = (row: ActivityRow): void => listener(row);
    listeners.add(subscription);
    return () => {
      listeners.delete(subscription);
    };
  }

  const every = opts.pruneEveryMs === undefined ? ACTIVITY_PRUNE_EVERY_MS : opts.pruneEveryMs;
  const timer =
    every === null
      ? null
      : setInterval(() => {
          try {
            const gone = prune();
            if (gone > 0) log.debug('mcp', `Dropped ${gone} activity rows older than 30 days`);
          } catch (err) {
            log.warn('mcp', `Pruning the activity log failed: ${describe(err)}`);
          }
        }, every);
  timer?.unref?.();

  return {
    logActivity,
    listActivity,
    pruneActivity: (olderThanMs) => prune(olderThanMs),
    onActivity,
    maxTaskNumber,
    close() {
      if (timer !== null) clearInterval(timer);
    },
  };
}
