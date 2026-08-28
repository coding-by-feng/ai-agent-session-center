/**
 * searchPrompts — the global prompt trace query behind GET /api/db/prompts.
 *
 * The facets are the load-bearing part: ~10% of the rows in a real `prompts`
 * table were never typed by a human (the harness posts `<task-notification>` &
 * friends through the same UserPromptSubmit hook), so a wrong predicate here is
 * the difference between a prompt journal and a noise dump.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../src/types/session.js';

// db.ts is a module singleton bound at import time to APP_USER_DATA. Point it
// at a throwaway temp dir, then dynamically import so the schema is created
// there. The better-sqlite3 binding may be built for Electron's ABI, in which
// case it cannot load under system Node — skip rather than crash the worker.
let tmpRoot: string;
let db: typeof import('../server/db.js') | null = null;

const T0 = 1_700_000_000_000;

function makeSession(overrides: Partial<Session>): Session {
  return {
    sessionId: 'x',
    projectPath: '/tmp/proj',
    projectName: 'proj',
    title: 'Test',
    status: 'idle',
    animationState: 'idle',
    emote: null,
    startedAt: T0,
    lastActivityAt: T0,
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    events: [],
    ...overrides,
  } as Session;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aasc-prompts-test-'));
  process.env.APP_USER_DATA = tmpRoot;
  try {
    db = await import('../server/db.js');
  } catch {
    db = null;
    return;
  }

  db.upsertSession(makeSession({ sessionId: 's-alpha', projectPath: '/w/alpha', projectName: 'alpha', title: 'Alpha work' }));
  db.upsertSession(makeSession({ sessionId: 's-beta', projectPath: '/w/beta', projectName: 'beta', title: 'Beta work' }));

  // Human prose
  db.insertFullPrompt('s-alpha', 'add search feature for the conversation tab', T0 + 1);
  db.insertFullPrompt('s-alpha', 'now make it 100% faster', T0 + 2);
  db.insertFullPrompt('s-beta', 'do you remember the infringement ticket?', T0 + 3);
  // Slash / Codex-skill commands
  db.insertFullPrompt('s-alpha', '/retouch-current-prompt', T0 + 4);
  db.insertFullPrompt('s-beta', '$RetouchPrompt', T0 + 5);
  // Harness-injected — never typed by the user
  db.insertFullPrompt('s-alpha', '<task-notification>\n<task-id>abc</task-id>', T0 + 6);
  db.insertFullPrompt('s-beta', '<system-reminder>Message sent</system-reminder>', T0 + 7);
  db.insertFullPrompt('s-beta', '\n  <observed_from_primary_session>x', T0 + 8);
  // Blank
  db.insertFullPrompt('s-alpha', '   ', T0 + 9);
  // Prompt whose session row is later deleted (orphan)
  db.upsertSession(makeSession({ sessionId: 's-gone', projectPath: '/w/gone', projectName: 'gone' }));
  db.insertFullPrompt('s-gone', 'a prompt from a session that gets deleted', T0 + 10);
});

afterAll(() => {
  db?.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const texts = (r: { prompts: Array<{ text: string }> }) => r.prompts.map((p) => p.text);

describe('searchPrompts — source facets', () => {
  it('"mine" keeps prose and commands but drops harness-injected turns and blanks', (ctx) => {
    if (!db) return ctx.skip();
    const res = db.searchPrompts({ kind: 'mine', pageSize: 100 });
    expect(res.total).toBe(6);
    expect(texts(res).some((t) => t.startsWith('<'))).toBe(false);
    expect(texts(res)).toContain('/retouch-current-prompt');
    expect(texts(res)).toContain('$RetouchPrompt');
    expect(texts(res).some((t) => t.trim() === '')).toBe(false);
  });

  it('"agent" returns only injected turns — including one behind leading whitespace', (ctx) => {
    if (!db) return ctx.skip();
    const res = db.searchPrompts({ kind: 'agent', pageSize: 100 });
    expect(res.total).toBe(3);
    expect(texts(res).every((t) => t.trimStart().startsWith('<'))).toBe(true);
  });

  it('"cmd" covers both the slash form and Codex\'s $skill form', (ctx) => {
    if (!db) return ctx.skip();
    const res = db.searchPrompts({ kind: 'cmd', pageSize: 100 });
    expect(texts(res).sort()).toEqual(['$RetouchPrompt', '/retouch-current-prompt']);
  });

  it('"all" is unfiltered — blanks included', (ctx) => {
    if (!db) return ctx.skip();
    const res = db.searchPrompts({ kind: 'all', pageSize: 100 });
    expect(res.total).toBe(10);
  });

  it('defaults to "mine" when no kind is given', (ctx) => {
    if (!db) return ctx.skip();
    expect(db.searchPrompts({ pageSize: 100 }).total).toBe(db.searchPrompts({ kind: 'mine', pageSize: 100 }).total);
  });
});

describe('searchPrompts — text search', () => {
  it('matches a substring, case-insensitively', (ctx) => {
    if (!db) return ctx.skip();
    expect(texts(db.searchPrompts({ query: 'CONVERSATION', pageSize: 100 })))
      .toEqual(['add search feature for the conversation tab']);
  });

  it('treats % and _ as literals, not wildcards', (ctx) => {
    if (!db) return ctx.skip();
    // Unescaped, '100%' would degrade to a prefix match and sweep in siblings.
    const res = db.searchPrompts({ query: '100%', pageSize: 100 });
    expect(texts(res)).toEqual(['now make it 100% faster']);

    const underscore = db.searchPrompts({ query: 'a_d', pageSize: 100 });
    expect(underscore.total).toBe(0); // would match "add …" if _ stayed a wildcard
  });
});

describe('searchPrompts — joins, filters, paging', () => {
  it('deleting a session cascades away its prompts', (ctx) => {
    if (!db) return ctx.skip();
    db.deleteSessionCascade('s-gone');
    expect(db.searchPrompts({ query: 'session that gets deleted', kind: 'all' }).total).toBe(0);
  });

  it('still returns a prompt whose session row is missing (LEFT JOIN)', async (ctx) => {
    if (!db) return ctx.skip();
    // better-sqlite3 enables foreign keys by default, so `insertFullPrompt`
    // CANNOT create an orphan — it fails and swallows the error. Forge one on a
    // second connection with the constraint off, which is the only way to
    // exercise the null branch of the join. An inner join would hide this row.
    const { default: Database } = await import('better-sqlite3');
    const raw = new Database(join(tmpRoot, 'data', 'sessions.db'));
    raw.pragma('foreign_keys = OFF');
    raw.prepare('INSERT INTO prompts (session_id, text, timestamp) VALUES (?, ?, ?)')
      .run('s-vanished', 'orphaned prompt text', T0 + 11);
    raw.close();

    const res = db.searchPrompts({ query: 'orphaned prompt', kind: 'all' });
    expect(res.total).toBe(1);
    expect(res.prompts[0].session_id).toBe('s-vanished');
    expect(res.prompts[0].project_name).toBeNull();
    expect(res.prompts[0].session_title).toBeNull();
  });

  it('filters by project path and by session id', (ctx) => {
    if (!db) return ctx.skip();
    expect(db.searchPrompts({ project: '/w/beta', kind: 'mine', pageSize: 100 }).total).toBe(2);
    expect(db.searchPrompts({ session: 's-alpha', kind: 'mine', pageSize: 100 }).total).toBe(3);
  });

  it('filters by date range', (ctx) => {
    if (!db) return ctx.skip();
    const res = db.searchPrompts({ kind: 'all', dateFrom: T0 + 4, dateTo: T0 + 5, pageSize: 100 });
    expect(res.total).toBe(2);
  });

  it('returns newest first by default and paginates with a stable total', (ctx) => {
    if (!db) return ctx.skip();
    const page1 = db.searchPrompts({ kind: 'mine', page: 1, pageSize: 2 });
    const page2 = db.searchPrompts({ kind: 'mine', page: 2, pageSize: 2 });
    expect(page1.prompts).toHaveLength(2);
    expect(page1.total).toBe(page2.total);
    expect(page1.prompts[0].timestamp).toBeGreaterThan(page1.prompts[1].timestamp);
    // Pages must not overlap.
    const ids = new Set([...page1.prompts, ...page2.prompts].map((p) => p.id));
    expect(ids.size).toBe(4);
  });

  it('honours ascending sort', (ctx) => {
    if (!db) return ctx.skip();
    const res = db.searchPrompts({ kind: 'mine', sortDir: 'asc', pageSize: 100 });
    expect(res.prompts[0].timestamp).toBeLessThan(res.prompts[res.prompts.length - 1].timestamp);
  });

  it('carries the session title through the join', (ctx) => {
    if (!db) return ctx.skip();
    const res = db.searchPrompts({ session: 's-alpha', kind: 'mine', pageSize: 1 });
    expect(res.prompts[0].session_title).toBe('Alpha work');
    expect(res.prompts[0].project_path).toBe('/w/alpha');
  });
});
