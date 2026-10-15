// test/transcriptPhoneRedaction.test.ts — AASC-41 decision 3: the classic layout's GET /sessions/:id/transcript
// hides a secret file's content from a paired phone as the chat does: the route marks the entries (by call id,
// on each call's whole input), the phone profile hides by the marks, and the Mac sees every byte.
//
// HOME points at a temp dir (synthetic ~/.claude/projects). A header names the paired phone for the profile.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

import express from 'express';
import { readClaudeTranscript } from '../server/extractPreviousAnswer.js';
import { markTranscriptSecrets } from '../server/chat/transcriptMarks.js';
import { resetTranscriptLocatorCache } from '../server/chat/transcriptLocator.js';
import { createPhoneProfile } from '../server/mobile/phoneProfile.js';
import { claude, jsonl, tempDir } from './chatFixtures.js';

const HIDDEN = '[Hidden on phones: this touched a secret file]';
const SESSION = '5d0f3c1e-0000-4000-8000-0000000000a1';
const PHONE = { 'X-Forwarded-For': '192.168.1.80', 'X-Test-Phone': '1' };
const IPAD = { 'X-Forwarded-For': '192.168.1.81' };

let tmp = '';
let project = '';
let transcript = '';
let server: Server;
let base = '';
const savedHome = process.env.HOME;

beforeAll(async () => {
  tmp = realpathSync(tempDir('aasc41-transcript-'));
  process.env.HOME = join(tmp, 'home');
  resetTranscriptLocatorCache();
  project = join(tmp, 'home', 'proj');
  mkdirSync(project, { recursive: true });
  const dir = join(tmp, 'home', '.claude', 'projects', `-${project.replace(/^\//, '').replace(/\//g, '-')}`);
  mkdirSync(dir, { recursive: true });
  transcript = join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, jsonl([
    claude.user('look at the config'),
    claude.call('t1', 'Read', { file_path: join(project, '.env') }),
    claude.call('t2', 'Bash', { command: 'echo API_KEY=sk-inline >> .env' }),
    claude.call('t3', 'Read', { file_path: join(project, 'src/a.ts') }),
    // Results land in completion order, not call order.
    claude.result('t3', 'export const a = 1;'),
    claude.result('t1', 'API_KEY=sk-from-file'),
    claude.result('t2', 'done'),
    claude.result('ghost', 'a result with no call'),
  ]));

  const store = await import('../server/sessionStore.js');
  await store.createTerminalSession(SESSION, { host: 'localhost', workingDir: project, command: 'claude' });
  store.setSessionRemoteVisible(SESSION, true);

  const { default: apiRouter } = await import('../server/apiRouter.js');
  const app = express();
  app.use(express.json());
  app.use('/api', createPhoneProfile({
    phoneOf: (req) => (req.headers['x-test-phone'] === '1' ? 'dev-phone-test' : null),
    sharedProjectPaths: () => [project],
    knownProjectPaths: () => [],
    isOpsTerminal: () => false,
    isSharedSession: () => true,
    sessionOfTerminal: () => null,
    terminalOfSession: () => null,
    foregroundProcess: () => null,
    home: join(tmp, 'home'),
  }), apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

type Entry = Record<string, unknown>;

async function transcriptFor(headers: Record<string, string>): Promise<Entry[]> {
  const auth = await import('../server/authManager.js');
  const res = await fetch(`${base}/api/sessions/${SESSION}/transcript`, {
    headers: { ...headers, Authorization: `Bearer ${auth.createToken()}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Entry[] }).data;
}

describe('the transcript reader', () => {
  it('carries each call’s id and each result’s call id', () => {
    const entries = readClaudeTranscript(SESSION, project, null);
    expect(entries.filter((e) => e.role === 'tool_use').map((e) => (e as { id?: string }).id)).toEqual(['t1', 't2', 't3']);
    expect(entries.filter((e) => e.role === 'tool_result').map((e) => (e as { toolUseId?: string }).toolUseId))
      .toEqual(['t3', 't1', 't2', 'ghost']);
  });

  it('is marked by call id, whatever order the results came in', async () => {
    const marked = await markTranscriptSecrets(readClaudeTranscript(SESSION, project, null), { cli: 'claude', path: transcript }, project);
    const uses = Object.fromEntries(marked.filter((e) => e.role === 'tool_use').map((e) => [e.id, e]));
    expect(uses.t1).toMatchObject({ secret: true, secretInput: true, editPaths: [join(project, '.env')] });
    expect(uses.t2).toMatchObject({ secret: true });
    expect(uses.t3).not.toHaveProperty('secret');
    const results = Object.fromEntries(marked.filter((e) => e.role === 'tool_result').map((e) => [e.toolUseId, e]));
    expect(results.t1).toMatchObject({ secret: true });
    expect(results.t2).toMatchObject({ secret: true });
    expect(results.t3).not.toHaveProperty('secret');
    expect(results.ghost).toMatchObject({ callUnknown: true });
  });

  it('marks every call and result unknown when there is no transcript to judge them by', async () => {
    const marked = await markTranscriptSecrets(readClaudeTranscript(SESSION, project, null), null, project);
    expect(marked.filter((e) => e.role === 'tool_use' || e.role === 'tool_result').every((e) => e.callUnknown === true)).toBe(true);
  });
});

describe('GET /sessions/:id/transcript', () => {
  it('hides from a paired phone what touched a secret file, and what it can’t judge', async () => {
    const data = await transcriptFor(PHONE);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/sk-from-file|sk-inline|a result with no call/);
    const outputs = data.filter((e) => e.role === 'tool_result').map((e) => e.output);
    expect(outputs).toEqual(['export const a = 1;', HIDDEN, HIDDEN, HIDDEN]);
    const inputs = data.filter((e) => e.role === 'tool_use').map((e) => JSON.parse(e.input as string));
    expect(inputs).toEqual([
      { redacted: true, paths: [join(project, '.env')] },
      { redacted: true, note: 'Ran a command that touches a secret file' },
      { file_path: join(project, 'src/a.ts') },
    ]);
  });

  it('shows a password sign-in every byte', async () => {
    const text = JSON.stringify(await transcriptFor(IPAD));
    expect(text).toContain('sk-from-file');
    expect(text).toContain('sk-inline');
  });
});
