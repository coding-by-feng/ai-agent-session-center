// callMemory.ts — what AASC keeps from voice calls, once the person says so (Nov 22 2026).
//
// A call teaches things worth keeping: a preference ("from now on, open web work in a worktree"), a correction of a
// meaning or of a speech-to-text mistake ("central section" means central session), and a way of working that comes
// back call after call. callMemoryExtract.ts proposes them after a call; nothing here is used until the person keeps
// it (Settings → Voice calls → Memory, or the phone's Call memory screen), with a scope: Global, or one project.
//
//   propose(candidates, callId)  new rows `proposed`; a pattern waits as `watching` until a second call; a subject
//                                already proposed, kept or skipped is not asked again (key = kind + normalised words)
//   decide(id, action)           keep (scope, wording, `supersedes` retires the old item) · skip · retire
//   kept()                       what may be supplied; memoryBlock() picks what fits one request
//
// Every text is one line, token shapes blanked, cut short. The rows live in the server's SQLite (`voice_memory`), on
// this Mac only: never synced, never written to an agent's rules or memory files.

import { scrubText, type SqlDatabase } from '../mcp/activity.js';
import { fence } from '../mcp/tools/define.js';

export type MemoryKind = 'preference' | 'correction' | 'pattern';
export type MemoryStatus = 'watching' | 'proposed' | 'kept' | 'skipped' | 'retired';
export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'correction', 'pattern'];

/** The longest meaning kept; the words as heard are cut shorter. */
export const MEANT_MAX = 240;
export const HEARD_MAX = 160;
/** Separate calls a pattern must come up in before it is proposed. */
export const PATTERN_CALLS = 2;
/** The most characters of kept items typed with one request. */
export const MEMORY_BLOCK_MAX = 600;

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  /** What the person meant, as AASC will use it. */
  meant: string;
  /** What speech-to-text wrote (evidence; for a correction, the misheard words). */
  heard: string;
  /** `global`, or `project:<absolute path>`. */
  scope: string;
  status: MemoryStatus;
  callId: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /** The kept item this one replaced. */
  supersedes: string | null;
  key: string;
  /** Separate calls this came up in. */
  seenCount: number;
}

export interface MemoryCandidate {
  kind: MemoryKind;
  meant: string;
  heard: string;
  scope: string;
}

export type MemoryDecision =
  | { action: 'keep'; scope?: string; meant?: string; supersedes?: string }
  | { action: 'skip' }
  | { action: 'retire' };

export interface CallMemory {
  propose(candidates: readonly MemoryCandidate[], callId: string): MemoryItem[];
  decide(id: string, decision: MemoryDecision): MemoryItem | null;
  list(): MemoryItem[];
  kept(): MemoryItem[];
  get(id: string): MemoryItem | null;
  /** The newest item about this subject (memoryKey), retired ones left out. */
  byKey(key: string): MemoryItem | null;
  touch(ids: readonly string[]): void;
}

export interface CallMemoryOptions {
  /** The database, opened on first use (the server passes `dbHandle`). */
  db: () => SqlDatabase;
  now?: () => number;
  newId?: () => string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS voice_memory (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    meant TEXT NOT NULL,
    heard TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    call_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    supersedes TEXT,
    key TEXT NOT NULL,
    seen_calls TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_voice_memory_key ON voice_memory(key);
`;

const SCOPE_RE = /^(global|project:\/.{0,1000})$/;

/** A scope as stored, or an error: `global`, or `project:` and an absolute path. */
export function checkScope(scope: string): string {
  if (!SCOPE_RE.test(scope)) throw new Error(`Not a memory scope: ${scope.slice(0, 80)}`);
  return scope;
}

const normalise = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The subject an item is about: a correction by its misheard words, anything else by its meaning. */
export const memoryKey = (c: Pick<MemoryCandidate, 'kind' | 'meant' | 'heard'>): string =>
  `${c.kind}:${normalise(c.kind === 'correction' ? c.heard : c.meant)}`;

interface Row {
  id: string; kind: string; meant: string; heard: string; scope: string; status: string; call_id: string;
  created_at: number | bigint; updated_at: number | bigint; last_used_at: number | bigint | null; supersedes: string | null;
  key: string; seen_calls: string;
}

function seenCalls(row: Row): string[] {
  try {
    const parsed: unknown = JSON.parse(row.seen_calls);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function toItem(row: Row): MemoryItem {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    meant: row.meant,
    heard: row.heard,
    scope: row.scope,
    status: row.status as MemoryStatus,
    callId: row.call_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    supersedes: row.supersedes,
    key: row.key,
    seenCount: seenCalls(row).length,
  };
}

const randomId = (): string => `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function createCallMemory(opts: CallMemoryOptions): CallMemory {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? randomId;
  let db: SqlDatabase | null = null;

  function ready(): SqlDatabase {
    if (db !== null) return db;
    const opened = opts.db();
    opened.exec(SCHEMA);
    db = opened;
    return opened;
  }

  const rows = (sql: string, ...params: Array<string | number | null>): Row[] =>
    ready().prepare(sql).all(...params) as Row[];
  const write = (sql: string, ...params: Array<string | number | null>): void => {
    const statement = ready().prepare(sql);
    Reflect.apply(statement.run, statement, params);
  };

  const get = (id: string): MemoryItem | null => {
    const [row] = rows('SELECT * FROM voice_memory WHERE id = ?', id);
    return row ? toItem(row) : null;
  };

  function proposeOne(c: MemoryCandidate, callId: string): MemoryItem | null {
    if (!MEMORY_KINDS.includes(c.kind)) return null;
    const meant = scrubText(c.meant, MEANT_MAX);
    const heard = scrubText(c.heard, HEARD_MAX);
    if (!meant) return null;
    const scope = checkScope(c.scope);
    const key = memoryKey({ kind: c.kind, meant, heard });
    const [existing] = rows("SELECT * FROM voice_memory WHERE key = ? AND status != 'retired' ORDER BY created_at DESC LIMIT 1", key);
    const at = now();
    if (existing) {
      // Already asked about (or kept, or skipped): only a watched pattern moves on, once a new call brings it up.
      if (existing.status !== 'watching') return null;
      const calls = seenCalls(existing);
      if (calls.includes(callId)) return null;
      const seen = [...calls, callId];
      const status: MemoryStatus = seen.length >= PATTERN_CALLS ? 'proposed' : 'watching';
      write('UPDATE voice_memory SET seen_calls = ?, status = ?, updated_at = ?, meant = ?, heard = ? WHERE id = ?',
        JSON.stringify(seen), status, at, meant, heard, existing.id);
      return status === 'proposed' ? get(existing.id) : null;
    }
    const id = newId();
    const status: MemoryStatus = c.kind === 'pattern' && PATTERN_CALLS > 1 ? 'watching' : 'proposed';
    write(
      'INSERT INTO voice_memory (id, kind, meant, heard, scope, status, call_id, created_at, updated_at, last_used_at, supersedes, key, seen_calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
      id, c.kind, meant, heard, scope, status, callId, at, at, key, JSON.stringify([callId]),
    );
    return status === 'proposed' ? get(id) : null;
  }

  return {
    propose(candidates, callId) {
      const out: MemoryItem[] = [];
      for (const c of candidates) {
        const item = proposeOne(c, callId);
        if (item) out.push(item);
      }
      return out;
    },
    decide(id, decision) {
      const item = get(id);
      if (!item) return null;
      const at = now();
      if (decision.action === 'skip') {
        write("UPDATE voice_memory SET status = 'skipped', updated_at = ? WHERE id = ?", at, id);
      } else if (decision.action === 'retire') {
        write("UPDATE voice_memory SET status = 'retired', updated_at = ? WHERE id = ?", at, id);
      } else {
        const scope = decision.scope === undefined ? item.scope : checkScope(decision.scope);
        const meant = decision.meant === undefined ? item.meant : scrubText(decision.meant, MEANT_MAX);
        if (!meant) throw new Error('A kept item needs its meaning');
        const old = decision.supersedes && decision.supersedes !== id ? get(decision.supersedes) : null;
        write("UPDATE voice_memory SET status = 'kept', scope = ?, meant = ?, supersedes = ?, updated_at = ? WHERE id = ?",
          scope, meant, old?.id ?? item.supersedes, at, id);
        if (old) write("UPDATE voice_memory SET status = 'retired', updated_at = ? WHERE id = ?", at, old.id);
      }
      return get(id);
    },
    list: () => rows("SELECT * FROM voice_memory WHERE status != 'watching' ORDER BY created_at").map(toItem),
    kept: () => rows("SELECT * FROM voice_memory WHERE status = 'kept' ORDER BY created_at").map(toItem),
    get,
    byKey(key) {
      const [row] = rows("SELECT * FROM voice_memory WHERE key = ? AND status != 'retired' ORDER BY created_at DESC LIMIT 1", key);
      return row ? toItem(row) : null;
    },
    touch(ids) {
      const at = now();
      for (const id of ids) write('UPDATE voice_memory SET last_used_at = ? WHERE id = ?', at, id);
    },
  };
}

/** Whether a caller may see an item: this Mac sees all; a remote device global items and the projects it can see. */
export function visibleTo(item: Pick<MemoryItem, 'scope'>, caller: { isLocal: boolean; projects: readonly string[] }): boolean {
  if (caller.isLocal || item.scope === 'global') return true;
  return item.scope.startsWith('project:') && caller.projects.includes(item.scope.slice('project:'.length));
}

const words = (text: string): Set<string> => new Set(normalise(text).split(' ').filter((w) => w.length > 2));

/**
 * The kept items to type with one request: every correction in scope (they fix how words are heard), then the
 * preferences and patterns in scope, those sharing words with the request first. `projects` are the projects of the
 * sessions the caller can see; an item of another project is left out.
 */
export function memoryBlock(items: readonly MemoryItem[], request: string, projects: readonly string[]): { text: string; used: string[] } {
  const inScope = items.filter((i) => i.status === 'kept' && (i.scope === 'global' || projects.includes(i.scope.slice('project:'.length))));
  if (inScope.length === 0) return { text: '', used: [] };
  const asked = words(request);
  const overlap = (i: MemoryItem): number => [...words(i.meant)].filter((w) => asked.has(w)).length;
  const corrections = inScope.filter((i) => i.kind === 'correction');
  const rest = inScope.filter((i) => i.kind !== 'correction').sort((a, b) => overlap(b) - overlap(a));
  const lines: string[] = [];
  const used: string[] = [];
  let room = MEMORY_BLOCK_MAX - 120;
  for (const i of [...corrections, ...rest]) {
    const line = i.kind === 'correction' ? `"${i.heard}" means ${i.meant}` : i.meant;
    if (line.length + 3 > room) continue;
    lines.push(line);
    used.push(i.id);
    room -= line.length + 3;
  }
  if (lines.length === 0) return { text: '', used: [] };
  return {
    text: `Kept for this person (they approved these; follow them unless they say otherwise now): ${fence('aasc:memory', 'memory', lines.join(' ;; '))}`,
    used,
  };
}
