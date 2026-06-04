import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../src/types/session.js';

// db.ts is a module singleton bound at import time to APP_USER_DATA. Point it
// at a throwaway temp dir, then dynamically import so the schema is created there.
// The better-sqlite3 native binding may be built for Electron's ABI (after an
// electron:build), in which case it cannot load under system Node — skip rather
// than crash the worker. Run `npm rebuild better-sqlite3` to enable locally.
let tmpRoot: string;
let db: typeof import('../server/db.js') | null = null;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aasc-db-test-'));
  process.env.APP_USER_DATA = tmpRoot;
  try {
    db = await import('../server/db.js');
  } catch {
    db = null; // native binding unavailable in this environment
  }
});

afterAll(() => {
  db?.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSession(overrides: Partial<Session>): Session {
  return {
    sessionId: 'x',
    projectPath: '/tmp/proj',
    projectName: 'proj',
    title: 'Test',
    status: 'idle',
    animationState: 'idle',
    emote: null,
    startedAt: 1000,
    lastActivityAt: 1000,
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    events: [],
    ...overrides,
  } as Session;
}

describe('migrateSessionId — parent sessions row', () => {
  it('deletes the orphaned old row when the new row already exists (upsert-then-migrate path)', (ctx) => {
    if (!db) return ctx.skip();
    // Old row persisted while still "connecting" (the orphan-producing state)
    db.upsertSession(makeSession({ sessionId: 'old-connecting', status: 'connecting' }));
    // New row created by the upsert that runs before migrate on SESSION_START
    db.upsertSession(makeSession({ sessionId: 'new-uuid', status: 'idle' }));

    db.migrateSessionId('old-connecting', 'new-uuid');

    const rows = db.searchSessions({ project: '/tmp/proj' }).sessions;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('new-uuid');
    expect(ids).not.toContain('old-connecting'); // orphan removed → no duplicate
  });

  it('renames the old row in place when the new row does not yet exist', (ctx) => {
    if (!db) return ctx.skip();
    db.upsertSession(makeSession({ sessionId: 'old-only', status: 'connecting' }));

    db.migrateSessionId('old-only', 'renamed-uuid');

    const detail = db.getSessionDetail('renamed-uuid');
    expect(detail).not.toBeNull();
    expect(db.getSessionDetail('old-only')).toBeNull();
  });

  it('re-points child prompts to the new id and leaves no duplicate parent', (ctx) => {
    if (!db) return ctx.skip();
    db.upsertSession(
      makeSession({
        sessionId: 'old-with-prompt',
        status: 'connecting',
        promptHistory: [{ text: 'hi test', timestamp: 1234 }],
      }),
    );
    db.upsertSession(makeSession({ sessionId: 'new-with-prompt', status: 'idle' }));

    db.migrateSessionId('old-with-prompt', 'new-with-prompt');

    const prompts = db.getPromptsForSession('new-with-prompt');
    expect(prompts.map((p) => p.text)).toContain('hi test');
    expect(db.getSessionDetail('old-with-prompt')).toBeNull();
  });

  it('is a no-op when old and new ids are identical', (ctx) => {
    if (!db) return ctx.skip();
    db.upsertSession(makeSession({ sessionId: 'same-id', status: 'idle' }));
    expect(() => db.migrateSessionId('same-id', 'same-id')).not.toThrow();
    expect(db.getSessionDetail('same-id')).not.toBeNull();
  });
});
