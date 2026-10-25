import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../src/types/session.js';

// The two history reads behind the RESOURCES Library's use counts (Oct 23 2026):
// prompts that could name a skill, and Claude's Skill tool calls, each call paired
// with the latest prompt of its own session at or before it — the prompt it answered,
// so a typed "/rar" the model then ran is counted once (server/resourceUsage.ts).
//
// db.ts is a module singleton bound at import time to APP_USER_DATA; see
// dbMigrateSession.test.ts for why a missing native binding skips instead.
let tmpRoot: string;
let db: typeof import('../server/db.js') | null = null;

function session(id: string, prompts: Array<[number, string]>, tools: Array<[number, string, string]>): Session {
  return {
    sessionId: id,
    projectPath: '/tmp/usage-proj',
    projectName: 'usage-proj',
    title: id,
    status: 'ended',
    animationState: 'idle',
    emote: null,
    startedAt: 1_000,
    lastActivityAt: 9_000,
    endedAt: 9_000,
    currentPrompt: '',
    promptHistory: prompts.map(([timestamp, text]) => ({ text, timestamp })),
    toolLog: tools.map(([timestamp, tool, input]) => ({ tool, input, timestamp })),
    toolUsage: {},
    totalToolCalls: tools.length,
    events: [],
  } as unknown as Session;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aasc-db-usage-test-'));
  process.env.APP_USER_DATA = tmpRoot;
  try {
    db = await import('../server/db.js');
  } catch {
    db = null;
    return;
  }
  db.upsertSession(session('use-a', [
    [1_000, 'old prompt /rar'],
    [2_000, 'fix it /rar'],
    [3_000, 'no skill named here'],
    [4_000, '<task-notification>/rar</task-notification>'],
  ], [
    [2_100, 'Skill', '{"skill":"rar","args":"fix it"}'],
    [3_100, 'Skill', '{"skill":"tdd"}'],
    [3_200, 'Bash', 'ls /rar'],
  ]));
  // Another session's later prompt must never be paired with use-a's calls.
  db.upsertSession(session('use-b', [[2_050, 'unrelated /other']], [[500, 'Skill', '{"skill":"early"}']]));
  // A harness row between the typed prompt and its call: the call still answers the typed one.
  db.upsertSession(session('use-c', [
    [5_000, 'go /rar'],
    [5_050, '<task-notification>a background shell ended</task-notification>'],
  ], [[5_100, 'Skill', '{"skill":"rar"}']]));
});

afterAll(() => {
  db?.closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getPromptUsesSince', () => {
  it('reads the prompts since a time that could name a skill, leaving harness rows out', (ctx) => {
    if (!db) return ctx.skip();
    const rows = db.getPromptUsesSince(1_500).sort((a, b) => a.timestamp - b.timestamp);
    expect(rows).toEqual([
      { timestamp: 2_000, text: 'fix it /rar' },
      { timestamp: 2_050, text: 'unrelated /other' },
      { timestamp: 5_000, text: 'go /rar' },
    ]);
  });
});

describe('getSkillCallsSince', () => {
  it('pairs each Skill call with the latest prompt the user sent in its own session at or before it', (ctx) => {
    if (!db) return ctx.skip();
    const rows = db.getSkillCallsSince(0).sort((a, b) => a.timestamp - b.timestamp);
    expect(rows).toEqual([
      { sessionId: 'use-b', timestamp: 500, input: '{"skill":"early"}', promptAt: null, prompt: null },
      { sessionId: 'use-a', timestamp: 2_100, input: '{"skill":"rar","args":"fix it"}', promptAt: 2_000, prompt: 'fix it /rar' },
      { sessionId: 'use-a', timestamp: 3_100, input: '{"skill":"tdd"}', promptAt: 3_000, prompt: 'no skill named here' },
      // The <task-notification> at 5,050 is skipped: the call answers the typed "go /rar".
      { sessionId: 'use-c', timestamp: 5_100, input: '{"skill":"rar"}', promptAt: 5_000, prompt: 'go /rar' },
    ]);
  });

  it('leaves out calls before the window', (ctx) => {
    if (!db) return ctx.skip();
    expect(db.getSkillCallsSince(3_000).map((r) => r.timestamp)).toEqual([3_100, 5_100]);
  });
});

// Plan 16 (Oct 24 2026): a phone's counts read only the sessions shared with it.
describe('the session-scoped reads', () => {
  it('read only the listed sessions, and nothing for an empty list', (ctx) => {
    if (!db) return ctx.skip();
    expect(db.getPromptUsesSince(0, ['use-c']).map((r) => r.text)).toEqual(['go /rar']);
    expect(db.getSkillCallsSince(0, ['use-a', 'use-b']).map((r) => r.sessionId).sort()).toEqual(['use-a', 'use-a', 'use-b']);
    expect(db.getPromptUsesSince(0, [])).toEqual([]);
    expect(db.getSkillCallsSince(0, [])).toEqual([]);
  });
});
