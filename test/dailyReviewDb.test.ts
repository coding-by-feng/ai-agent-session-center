/**
 * The daily review's two database reads and its one write (Nov 20 2026): a day's typed prompts with
 * their session's project and title, and the kept summary of a day.
 *
 * db.ts binds to APP_USER_DATA at import, so this points it at a throwaway temp dir first and never
 * reaches a real sessions.db. When better-sqlite3 is built for Electron's ABI the import fails and
 * the tests skip instead of crashing the worker (as searchPrompts.test.ts does).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../src/types/session.js';

const T0 = new Date(2026, 10, 20, 0, 0).getTime();
const T1 = new Date(2026, 10, 21, 0, 0).getTime();

const session = (sessionId: string, over: Partial<Session> = {}) => ({
  sessionId, projectPath: '/w/am', projectName: 'agent-manager', title: 'Plan 18', status: 'idle',
  animationState: 'idle', emote: null, startedAt: T0, lastActivityAt: T0, endedAt: null, currentPrompt: '',
  promptHistory: [], toolUsage: {}, totalToolCalls: 0, events: [], ...over,
}) as unknown as Session;

// Bound before the import, at module load, so `describe.skipIf` below reports a driver that cannot
// load as SKIPPED rather than as a pass that checked nothing.
const previous = process.env.APP_USER_DATA;
const tmpRoot = mkdtempSync(join(tmpdir(), 'aasc-daily-review-test-'));
process.env.APP_USER_DATA = tmpRoot;
let db: typeof import('../server/db.js') | null = null;
try {
  db = await import('../server/db.js');
} catch {
  db = null;
}

beforeAll(() => {
  if (!db) return;
  db.upsertSession(session('s1'));
  db.upsertSession(session('w1', { projectPath: '/w/site', projectName: 'website', title: 'Terms' }));
  db.insertFullPrompt('s1', 'before the day', T0 - 1);
  db.insertFullPrompt('s1', 'first of the day', T0);
  db.insertFullPrompt('s1', '\n  <task-notification>done</task-notification>', T0 + 10);
  db.insertFullPrompt('s1', '   ', T0 + 20);
  db.insertFullPrompt('w1', 'terms page', T0 + 30);
  db.insertFullPrompt('s1', '/rar add a daily review', T0 + 40);
  db.insertFullPrompt('s1', 'last moment of the day', T1 - 1);
  db.insertFullPrompt('s1', 'next day', T1);
});

afterAll(() => {
  if (previous === undefined) delete process.env.APP_USER_DATA;
  else process.env.APP_USER_DATA = previous;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe.skipIf(!db)('getTypedPromptsInRange', () => {
  it('returns the day’s typed prompts oldest first, without harness tags or blank rows', () => {
    const rows = db!.getTypedPromptsInRange(T0, T1);
    expect(rows.map((r) => r.text)).toEqual(['first of the day', 'terms page', '/rar add a daily review', 'last moment of the day']);
  });

  it('carries each prompt’s session project and title', () => {
    const terms = db!.getTypedPromptsInRange(T0, T1).find((r) => r.text === 'terms page');
    expect(terms).toMatchObject({ session_id: 'w1', project_name: 'website', project_path: '/w/site', session_title: 'Terms', timestamp: T0 + 30 });
    expect(typeof terms?.id).toBe('number');
  });
});

describe.skipIf(!db)('daily summaries', () => {
  it('is null for a day never summarized, and keeps the newest summary of a day', () => {
    expect(db!.getDailySummary('2026-11-20')).toBeNull();
    const first = { day: '2026-11-20', summary: '• one', model: 'haiku', promptCount: 3, sessionCount: 2, fingerprint: 'aa', generatedAt: T1 };
    db!.saveDailySummary(first);
    expect(db!.getDailySummary('2026-11-20')).toEqual(first);
    const second = { ...first, summary: '• two', promptCount: 4, fingerprint: 'bb', generatedAt: T1 + 5 };
    db!.saveDailySummary(second);
    expect(db!.getDailySummary('2026-11-20')).toEqual(second);
    expect(db!.getDailySummary('2026-11-19')).toBeNull();
  });
});
