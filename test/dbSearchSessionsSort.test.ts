import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../src/types/session.js';

// The HISTORY tab's "Prompts" and "Tools" sorts. searchSessions interpolates the
// sort column into ORDER BY, so it whitelists it; total_prompts and
// total_tool_calls were missing from that whitelist and both sorts silently fell
// back to started_at (Oct 2026). Anything outside the whitelist must still fall
// back — including the single-statement SQL a looser check (a prefix match, a
// regex without `$`) would let through, and the array a repeated query key
// becomes.
//
// db.ts is a module singleton bound at import time to APP_USER_DATA; see
// dbMigrateSession.test.ts for why a missing native binding skips instead
// (after `npm run electron:rebuild` the binding is Electron's ABI and these
// skip under system Node; `npm rebuild better-sqlite3` runs them).
let tmpRoot: string;
let db: typeof import('../server/db.js') | null = null;

function makeSession(id: string, startedAt: number, prompts: number, tools: number): Session {
  return {
    sessionId: id,
    projectPath: '/tmp/sort-proj',
    projectName: 'sort-proj',
    // Titles do NOT sort the same way as start time, so an ORDER BY title that
    // slipped through would be visible.
    title: { 'sort-a': 'zulu', 'sort-b': 'alpha', 'sort-c': 'mike' }[id] ?? id,
    status: 'ended',
    animationState: 'idle',
    emote: null,
    startedAt,
    lastActivityAt: startedAt,
    endedAt: startedAt + 1000,
    currentPrompt: '',
    promptHistory: Array.from({ length: prompts }, (_, i) => ({ text: `p${i}`, timestamp: startedAt + i })),
    toolUsage: {},
    totalToolCalls: tools,
    events: [],
  } as unknown as Session;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aasc-db-sort-test-'));
  process.env.APP_USER_DATA = tmpRoot;
  try {
    db = await import('../server/db.js');
  } catch {
    db = null;
    return;
  }
  // Start order (newest first): c, b, a. Prompt order: b > a > c. Tool order: a > c > b.
  db.upsertSession(makeSession('sort-a', 1_000, 5, 90));
  db.upsertSession(makeSession('sort-b', 2_000, 9, 10));
  db.upsertSession(makeSession('sort-c', 3_000, 1, 50));
});

afterAll(() => {
  db?.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const ids = (sortBy: unknown, sortDir: 'asc' | 'desc' = 'desc') =>
  db!
    .searchSessions({ project: '/tmp/sort-proj', sortBy: sortBy as never, sortDir })
    .sessions.map((s) => s.id);

const BY_START = ['sort-c', 'sort-b', 'sort-a'];

describe('searchSessions — sort columns', () => {
  it('sorts by total_prompts and total_tool_calls, not by start time', (ctx) => {
    if (!db) return ctx.skip();
    expect(ids('started_at')).toEqual(BY_START);
    expect(ids('total_prompts')).toEqual(['sort-b', 'sort-a', 'sort-c']);
    expect(ids('total_tool_calls')).toEqual(['sort-a', 'sort-c', 'sort-b']);
    expect(ids('total_tool_calls', 'asc')).toEqual(['sort-b', 'sort-c', 'sort-a']);
  });

  // `it.for`, not `it.each`: only `for` hands the callback the test context
  // (needed to skip when the native binding is unavailable).
  it.for([
    { label: 'a valid single-statement CASE expression', sortBy: '(CASE WHEN 1=1 THEN total_prompts ELSE started_at END)' },
    { label: 'a whitelisted column with a suffix', sortBy: 'total_prompts, (SELECT 1)' },
    { label: 'a stacked statement', sortBy: 'title; DROP TABLE sessions' },
    { label: 'another column name', sortBy: 'title' },
    { label: 'a case-changed column name', sortBy: 'TOTAL_PROMPTS' },
    { label: 'the array a repeated query key becomes', sortBy: ['total_prompts'] as unknown },
    { label: 'an object', sortBy: {} as unknown },
  ])('falls back to start time for $label', ({ sortBy }, ctx) => {
    if (!db) return ctx.skip();
    expect(() => ids(sortBy)).not.toThrow();
    expect(ids(sortBy)).toEqual(BY_START);
  });
});
