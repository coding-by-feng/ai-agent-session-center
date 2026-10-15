// test/transcriptOwnership.test.ts — AASC-49: a session only ever sees its own transcript.
//
// findTranscriptFile fell back to the NEWEST .jsonl in ~/.claude/projects/<project> whenever
// `<sessionId>.jsonl` wasn't there. A Codex session has no transcriptPath (its hook sends none) and its
// id never names a Claude file, so the CONVERSATION tab (and the translate-answer AI popup) showed
// whichever Claude conversation in the same project was written last. Same for a Claude session whose
// transcript was missing: it borrowed a neighbour's.
//
// HOME points at a temp dir, so ~/.claude/projects is synthetic; no real transcript is read.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

import express from 'express';
import { createServer, type Server } from 'http';
import { readClaudeLastAssistant, readClaudeTranscript } from '../server/extractPreviousAnswer.js';
import { transcriptCliOf } from '../server/chat/transcriptLocator.js';

let tmp = '';
let home = '';
let project = '';
let projectDir = '';
let originalHome: string | undefined;
let server: Server;
let base = '';

const OWN_ID = '26bf87ee-a3f9-494c-b305-3354ed8f732c';
const OTHER_ID = '96c1e7a3-bac5-455d-9a23-dba22a2f3e96';
const CODEX_ID = '01a1288a-2ace-70c2-95a6-0b63700796e5';

function line(type: 'user' | 'assistant', text: string): string {
  return JSON.stringify({ type, timestamp: '2026-10-15T10:00:00.000Z', message: { role: type, content: text } });
}

function writeTranscript(id: string, lines: string[], mtimeSec?: number): string {
  const file = join(projectDir, `${id}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

beforeAll(async () => {
  originalHome = process.env.HOME;
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'aasc49-')));
  home = join(tmp, 'home');
  project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  process.env.HOME = home; // os.homedir() honours $HOME on POSIX
  projectDir = join(home, '.claude', 'projects', `-${project.replace(/^\//, '').replace(/\//g, '-')}`);
  mkdirSync(projectDir, { recursive: true });
  // Somebody else's conversation in the same project, written last (the old fallback's pick).
  writeTranscript(OTHER_ID, [line('user', 'other prompt'), line('assistant', 'OTHER SESSION ANSWER')], 2_000_000_000);

  const store = await import('../server/sessionStore.js');
  await store.createTerminalSession('aasc49-codex', { host: 'localhost', workingDir: project, command: 'codex' });
  await store.createTerminalSession(CODEX_ID, { host: 'localhost', workingDir: project, command: 'codex' });
  await store.createTerminalSession('aasc49-claude', { host: 'localhost', workingDir: project, command: 'claude' });
  await store.createTerminalSession(OWN_ID, { host: 'localhost', workingDir: project, command: 'claude' });

  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

async function transcriptOf(sessionId: string): Promise<Array<{ role: string; text?: string }>> {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/transcript`);
  const body = (await res.json()) as { success: boolean; data: Array<{ role: string; text?: string }> };
  expect(res.status).toBe(200);
  expect(body.success).toBe(true);
  return body.data;
}

describe('readClaudeTranscript', () => {
  it('reads nothing when only another conversation sits in the project folder', () => {
    expect(readClaudeTranscript('3f9e4c55-0000-4000-8000-000000000001', project, null)).toEqual([]);
  });

  it('reads the session’s own <sessionId>.jsonl', () => {
    writeTranscript(OWN_ID, [line('user', 'mine'), line('assistant', 'MY ANSWER')]);
    const texts = readClaudeTranscript(OWN_ID, project, null).map((e) => ('text' in e ? e.text : ''));
    expect(texts).toEqual(['mine', 'MY ANSWER']);
  });

  it('reads the recorded transcriptPath when the id names no file', () => {
    const recorded = writeTranscript('4b1d0c7e-0000-4000-8000-000000000002', [line('assistant', 'RECORDED')]);
    const texts = readClaudeTranscript('term-1785383529519-i4poz1', project, recorded).map((e) => ('text' in e ? e.text : ''));
    expect(texts).toEqual(['RECORDED']);
  });

  it('reads nothing for a session id that is not a plain token (no path tricks)', () => {
    expect(readClaudeTranscript(`../${projectDir.split('/').pop()}/${OTHER_ID}`, project, null)).toEqual([]);
  });

  it('reads nothing without a session id', () => {
    expect(readClaudeTranscript(null, project, null)).toEqual([]);
  });
});

describe('readClaudeLastAssistant', () => {
  it('finds no previous answer when only another conversation sits in the project folder', () => {
    expect(readClaudeLastAssistant('3f9e4c55-0000-4000-8000-000000000003', project, null)).toBeNull();
  });
});

describe('transcriptCliOf', () => {
  it.each([
    [{ cliSource: 'codex' }, 'codex'],
    [{ cliSource: 'CLAUDE' }, 'claude'],
    [{ cliSource: 'gemini', startupCommand: 'claude' }, null],
    [{ startupCommand: 'codex --yolo' }, 'codex'],
    [{ sshCommand: 'claude' }, 'claude'],
    [{ model: 'gpt-5-codex' }, 'codex'],
    [{ events: [{ type: 'SessionStart' }] }, 'claude'],
    [{}, null],
  ])('%j → %s', (session, cli) => {
    expect(transcriptCliOf(session)).toBe(cli);
  });
});

describe('GET /sessions/:id/transcript (AASC-49)', () => {
  it('gives a Codex session no conversation, never the newest Claude one in its project', async () => {
    expect(await transcriptOf('aasc49-codex')).toEqual([]);
  });

  it('never reads ~/.claude/projects for a Codex session, even a file named after it', async () => {
    writeTranscript(CODEX_ID, [line('assistant', 'A CLAUDE FILE WITH A CODEX NAME')]);
    expect(await transcriptOf(CODEX_ID)).toEqual([]);
  });

  it('gives a Claude session without a transcript no conversation, not a neighbour’s', async () => {
    expect(await transcriptOf('aasc49-claude')).toEqual([]);
  });

  it('still gives a Claude session its own conversation', async () => {
    writeTranscript(OWN_ID, [line('user', 'mine'), line('assistant', 'MY ANSWER')]);
    const texts = (await transcriptOf(OWN_ID)).map((e) => e.text);
    expect(texts).toEqual(['mine', 'MY ANSWER']);
  });
});
