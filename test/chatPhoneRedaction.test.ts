// test/chatPhoneRedaction.test.ts — AASC-41: a paired phone never gets a secret file's content through the chat,
// whichever page a tool call and its result land on. The redaction used to run on one response at a time, so
// a result whose call came in an earlier response (a live `after=` read, a page boundary) went out whole; and
// it read only `input.command`, missing Codex's `cmd`, `action.command` and script tools.
//
// Synthetic transcripts in temp dirs; the phone profile's phoneOf reads a test header.
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createChatRouter } from '../server/chat/chatRouter.js';
import { resetTranscriptLocatorCache } from '../server/chat/transcriptLocator.js';
import { HIDDEN_ON_PHONES } from '../server/mobile/phoneChatFilter.js';
import { createPhoneProfile } from '../server/mobile/phoneProfile.js';
import type { ChatPage, ChatEntry } from '../src/types/chat.js';
import { appendJsonl, claude, codex, tempDir, writeJsonl } from './chatFixtures.js';

const CODEX_ID = '01a1288a-2ace-70c2-95a6-0b63700796e5';
const PHONE = { 'X-Forwarded-For': '192.168.1.80', 'X-Test-Phone': '1' };

let tmp = '';
let claudeDir = '';
let rolloutFile = '';
let server: Server;
let base = '';
const saved: Record<string, string | undefined> = {};
const sessions = new Map<string, Record<string, unknown>>();

beforeAll(async () => {
  saved.HOME = process.env.HOME;
  saved.CODEX_HOME = process.env.CODEX_HOME;
  tmp = realpathSync(tempDir('aasc41-phone-'));
  process.env.HOME = join(tmp, 'home');
  process.env.CODEX_HOME = join(tmp, 'codex');
  resetTranscriptLocatorCache();
  claudeDir = join(tmp, 'home', '.claude', 'projects', '-proj');
  mkdirSync(claudeDir, { recursive: true });
  const day = join(tmp, 'codex', 'sessions', '2026', '10', '16');
  mkdirSync(day, { recursive: true });
  rolloutFile = join(day, `rollout-2026-10-16T10-00-00-${CODEX_ID}.jsonl`);
  sessions.set(CODEX_ID, { sessionId: CODEX_ID, cliSource: 'codex', projectPath: '/proj', remoteVisible: true });

  const app = express();
  // Mounted as server/index.ts mounts them: the phone profile (here a header names the paired phone), then
  // the chat router, whose reader marks what touched a secret file for the profile to hide.
  app.use('/api', createPhoneProfile({
    phoneOf: (req) => (req.headers['x-test-phone'] === '1' ? 'dev-phone-test' : null),
    sharedProjectPaths: () => [],
    knownProjectPaths: () => [],
    isOpsTerminal: () => false,
    isSharedSession: () => true,
    sessionOfTerminal: () => null,
    terminalOfSession: () => null,
    foregroundProcess: () => null,
    home: join(tmp, 'home'),
  }), createChatRouter({ getSession: (id) => (sessions.get(id) as never) ?? null }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
/** A fresh shared Claude session whose transcript holds `records`. */
function claudeSession(records: unknown[]): { id: string; file: string } {
  const id = `phone-${n++}`;
  const file = writeJsonl(join(claudeDir, `${id}.jsonl`), records);
  sessions.set(id, { sessionId: id, cliSource: 'claude', projectPath: '/proj', transcriptPath: file, remoteVisible: true });
  return { id, file };
}

async function page(id: string, query = '', headers: Record<string, string> = PHONE): Promise<ChatPage> {
  const res = await fetch(`${base}/api/sessions/${id}/chat${query}`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ChatPage }).data;
}

const results = (p: ChatPage) => p.entries.filter((e): e is Extract<ChatEntry, { kind: 'tool_result' }> => e.kind === 'tool_result');
const uses = (p: ChatPage) => p.entries.filter((e): e is Extract<ChatEntry, { kind: 'tool_use' }> => e.kind === 'tool_use');

beforeEach(() => {
  resetTranscriptLocatorCache();
});

describe('a result whose call is not in the same response', () => {
  it('stays hidden when it arrives in a later after= read (the live case)', async () => {
    const s = claudeSession([claude.user('show me the env'), claude.call('t1', 'Read', { file_path: '/proj/.env' })]);
    const first = await page(s.id);
    expect(uses(first)[0].input).toEqual({ file_path: '/proj/.env', redacted: true });

    appendJsonl(s.file, [claude.result('t1', 'API_KEY=sk-live-123')]);
    const next = await page(s.id, `?after=${encodeURIComponent(first.after as string)}`);
    expect(results(next)).toMatchObject([{ toolUseId: 't1', output: HIDDEN_ON_PHONES, truncated: false }]);
    expect(JSON.stringify(next)).not.toContain('sk-live-123');
  });

  it('stays hidden when a page boundary falls between the call and its result', async () => {
    const s = claudeSession([
      claude.call('t1', 'Bash', { command: 'cat .env' }),
      claude.result('t1', 'TOKEN=abc-secret'),
      ...Array.from({ length: 199 }, (_, i) => claude.user(`p${i}`)),
    ]);
    const newest = await page(s.id);
    expect(uses(newest)).toHaveLength(0); // the call is on the older page
    expect(results(newest)).toMatchObject([{ toolUseId: 't1', output: HIDDEN_ON_PHONES }]);
    expect(JSON.stringify(newest)).not.toContain('abc-secret');
  });

  it('is hidden on a phone when its call can’t be found at all (fail closed), and shown to the Mac', async () => {
    const s = claudeSession([claude.result('ghost', 'what was this?')]);
    expect(results(await page(s.id))[0].output).toBe(HIDDEN_ON_PHONES);
    expect(results(await page(s.id, '', {}))[0]).toMatchObject({ output: 'what was this?', callUnknown: true });
  });

  it('is shown when its call, found earlier in the file, touched nothing secret', async () => {
    const s = claudeSession([
      claude.call('t1', 'Read', { file_path: '/proj/src/app.ts' }),
      claude.result('t1', 'export const app = 1;'),
      ...Array.from({ length: 199 }, (_, i) => claude.user(`p${i}`)),
    ]);
    expect(results(await page(s.id))[0].output).toBe('export const app = 1;');
  });
});

describe('what counts as touching a secret file', () => {
  it('reads the whole command, not the 2 KB the chat shows', async () => {
    const s = claudeSession([
      claude.call('t1', 'Bash', { command: `${'echo padding; '.repeat(300)}cat ~/.aws/credentials` }),
      claude.result('t1', 'aws_secret_access_key=XYZ'),
    ]);
    const p = await page(s.id);
    expect(results(p)[0].output).toBe(HIDDEN_ON_PHONES);
  });

  it('reads Codex’s cmd, local shell action, script tools and patches inside scripts', async () => {
    writeJsonl(rolloutFile, [
      codex.meta(CODEX_ID),
      codex.functionCall('c1', 'exec_command', { cmd: 'cat .env', workdir: '/proj' }),
      codex.functionOutput('c1', 'DB_PASSWORD=hunter2'),
      { timestamp: '2026-10-16T10:00:00.000Z', type: 'response_item', payload: { type: 'local_shell_call', call_id: 'c2', action: { type: 'exec', command: ['bash', '-lc', 'cat ~/.ssh/config'] } } },
      codex.functionOutput('c2', 'Host secret-box'),
      codex.customCall('c3', 'exec', 'const r = await tools.exec_command({ cmd: "grep KEY .env.local" }); text(r);'),
      codex.customOutput('c3', [{ type: 'input_text', text: 'Script completed\nKEY=from-env-local' }]),
      codex.functionCall('c4', 'js', { code: 'await fs.readFile("config/credentials.json")', title: 'Read' }),
      codex.functionOutput('c4', 'client_secret=zzz'),
      codex.customCall('c5', 'exec', 'await tools.apply_patch("*** Begin Patch\\n*** Add File: /proj/.env\\n+SECRET=1\\n*** End Patch\\n");'),
      codex.customOutput('c5', [{ type: 'input_text', text: 'Script completed' }]),
      codex.functionCall('c6', 'exec_command', { cmd: 'ls src' }),
      codex.functionOutput('c6', 'app.ts'),
    ]);
    const p = await page(CODEX_ID);
    const out = Object.fromEntries(results(p).map((r) => [r.toolUseId, r.output]));
    expect(out).toEqual({
      c1: HIDDEN_ON_PHONES, c2: HIDDEN_ON_PHONES, c3: HIDDEN_ON_PHONES, c4: HIDDEN_ON_PHONES, c5: HIDDEN_ON_PHONES, c6: 'app.ts',
    });
    for (const secret of ['hunter2', 'secret-box', 'from-env-local', 'client_secret', 'SECRET=1']) {
      expect(JSON.stringify(p)).not.toContain(secret);
    }
  });

  it('hides a Codex file change to a secret file, and its outcome', async () => {
    writeJsonl(rolloutFile, [
      codex.meta(CODEX_ID),
      codex.fileChange('fc1', { '/proj/.env': { type: 'add', content: 'API=sk-999\n' }, '/proj/a.ts': { type: 'add', content: 'x\n' } }),
    ]);
    const p = await page(CODEX_ID);
    expect(uses(p)[0].input).toEqual({ redacted: true, paths: ['/proj/.env', '/proj/a.ts'] });
    expect(JSON.stringify(p)).not.toContain('sk-999');
  });

  it('leaves the Mac every byte, only marked', async () => {
    const s = claudeSession([claude.call('t1', 'Read', { file_path: '/proj/.env' }), claude.result('t1', 'API_KEY=sk-mac')]);
    const p = await page(s.id, '', {});
    expect(uses(p)[0]).toMatchObject({ input: { file_path: '/proj/.env' }, secret: true });
    expect(results(p)[0]).toMatchObject({ output: 'API_KEY=sk-mac', secret: true });
  });
});

describe('the edits list on a phone', () => {
  it('keeps a secret file in the list, marked, and gives no hunks for it', async () => {
    const s = claudeSession([
      claude.call('w1', 'Write', { file_path: '/proj/src/a.ts', content: 'a\n' }),
      claude.result('w1', 'ok'),
      claude.call('w2', 'Write', { file_path: '/proj/.env', content: 'API_KEY=sk-edit\n' }),
      claude.result('w2', 'ok'),
    ]);
    const list = await (await fetch(`${base}/api/sessions/${s.id}/changes`, { headers: PHONE })).json() as { data: { files: Array<Record<string, unknown>> } };
    expect(list.data.files.map((f) => [f.path, f.redacted ?? false])).toEqual([['.env', true], ['src/a.ts', false]]);
    const one = await (await fetch(`${base}/api/sessions/${s.id}/changes/0`, { headers: PHONE })).json() as { data: Record<string, unknown> };
    expect(one.data).toMatchObject({ path: '.env', hunks: [], redacted: true });
    expect(JSON.stringify(one)).not.toContain('sk-edit');
    const mac = await (await fetch(`${base}/api/sessions/${s.id}/changes/0`)).json();
    expect(JSON.stringify(mac)).toContain('sk-edit');
  });
});
