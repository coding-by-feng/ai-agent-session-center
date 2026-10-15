// test/chatSecretMarks.test.ts — AASC-41: the chat's page reader marks the tool calls that touched a secret file
// and their results, wherever a page starts; content is left as it is (the phone profile decides what to hide).
// A result whose call it can't find within its lookback budget is marked `callUnknown`.
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readClaudeChatPage } from '../server/chat/claudeTranscript.js';
import { readCodexChatPage } from '../server/chat/codexTranscript.js';
import type { ChatEntry } from '../src/types/chat.js';
import { appendJsonl, claude, codex, jsonl, tempDir, writeJsonl } from './chatFixtures.js';

let dir = '';
let file = '';

beforeEach(() => {
  dir = tempDir('aasc41-marks-');
  file = join(dir, 'transcript.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Use = Extract<ChatEntry, { kind: 'tool_use' }>;
type Result = Extract<ChatEntry, { kind: 'tool_result' }>;
const uses = (entries: ChatEntry[]) => entries.filter((e): e is Use => e.kind === 'tool_use');
const results = (entries: ChatEntry[]) => entries.filter((e): e is Result => e.kind === 'tool_result');
const marked = { markSecrets: true } as const;

describe('marks, content untouched', () => {
  it('marks a Read of .env and its result, keeping both whole', async () => {
    writeJsonl(file, [claude.call('t1', 'Read', { file_path: '/proj/.env' }), claude.result('t1', 'API_KEY=sk-1')]);
    const { entries } = await readClaudeChatPage(file, marked);
    expect(uses(entries)[0]).toMatchObject({ input: { file_path: '/proj/.env' }, secret: true, secretInput: true, editPaths: ['/proj/.env'] });
    expect(results(entries)[0]).toMatchObject({ output: 'API_KEY=sk-1', secret: true });
  });

  it('marks a command that names a secret file, but not its input as secret content', async () => {
    writeJsonl(file, [claude.call('t1', 'Bash', { command: 'cat .env' }), claude.result('t1', 'K=1')]);
    const { entries } = await readClaudeChatPage(file, marked);
    expect(uses(entries)[0]).toMatchObject({ secret: true });
    expect(uses(entries)[0]).not.toHaveProperty('secretInput');
    expect(results(entries)[0]).toMatchObject({ secret: true });
  });

  it('judges the whole command, not the 2 KB the chat shows', async () => {
    writeJsonl(file, [
      claude.call('t1', 'Bash', { command: `${'echo padding; '.repeat(300)}cat ~/.aws/credentials` }),
      claude.result('t1', 'aws_secret=1'),
    ]);
    const { entries } = await readClaudeChatPage(file, marked);
    expect(uses(entries)[0]).toMatchObject({ secret: true, inputTruncated: true });
    expect(results(entries)[0]).toMatchObject({ secret: true });
  });

  it('marks nothing on ordinary calls, and nothing at all unless asked', async () => {
    writeJsonl(file, [
      claude.call('t1', 'Read', { file_path: '/proj/src/a.ts' }), claude.result('t1', 'x'),
      claude.call('t2', 'Read', { file_path: '/proj/.env' }), claude.result('t2', 'K=1'),
    ]);
    const asked = (await readClaudeChatPage(file, marked)).entries;
    expect(uses(asked)[0]).not.toHaveProperty('secret');
    expect(results(asked)[0]).not.toHaveProperty('secret');
    expect(results(asked)[0]).not.toHaveProperty('callUnknown');
    const plain = (await readClaudeChatPage(file)).entries;
    expect(JSON.stringify(plain)).not.toMatch(/secret|callUnknown/i);
  });
});

describe('a result whose call is in an earlier page', () => {
  it('is marked when it arrives in a later after= read', async () => {
    writeJsonl(file, [claude.call('t1', 'Read', { file_path: '/proj/.env' })]);
    const first = await readClaudeChatPage(file, marked);
    appendJsonl(file, [claude.result('t1', 'API_KEY=sk-2')]);
    const next = await readClaudeChatPage(file, { ...marked, after: first.after });
    expect(results(next.entries)).toMatchObject([{ toolUseId: 't1', secret: true }]);
  });

  it('is marked when a page boundary falls between them (the call read but not on the page)', async () => {
    writeJsonl(file, [
      claude.call('t1', 'Bash', { command: 'cat .env' }),
      claude.result('t1', 'K=1'),
      claude.user('later'),
    ]);
    const { entries } = await readClaudeChatPage(file, { ...marked, limit: 2 });
    expect(uses(entries)).toHaveLength(0);
    expect(results(entries)).toMatchObject([{ toolUseId: 't1', secret: true }]);
  });

  it('is found further back than the page read, within one more scan budget', async () => {
    const filler = Array.from({ length: 20 }, (_, i) => claude.user(`filler ${i} ${'x'.repeat(40)}`));
    writeJsonl(file, [claude.call('t1', 'Read', { file_path: '/proj/.env' }), ...filler, claude.result('t1', 'K=1')]);
    const total = Buffer.byteLength(jsonl([claude.call('t1', 'Read', { file_path: '/proj/.env' }), ...filler, claude.result('t1', 'K=1')]));
    // The page's window (the last 60% of the file) doesn't reach the call; the lookback (the same budget again) does.
    const scanBytes = Math.ceil(total * 0.6);
    const { entries } = await readClaudeChatPage(file, { ...marked, limit: 1, scanBytes });
    expect(results(entries)).toMatchObject([{ toolUseId: 't1', secret: true }]);
  });

  it('is marked callUnknown when its call is further back than the lookback budget, or nowhere', async () => {
    const filler = Array.from({ length: 40 }, (_, i) => claude.user(`filler ${i} ${'x'.repeat(40)}`));
    writeJsonl(file, [claude.call('t1', 'Read', { file_path: '/proj/src/a.ts' }), ...filler, claude.result('t1', 'fine')]);
    const far = await readClaudeChatPage(file, { ...marked, limit: 1, scanBytes: 300 });
    expect(results(far.entries)).toMatchObject([{ toolUseId: 't1', output: 'fine', callUnknown: true }]);

    writeJsonl(file, [claude.result('ghost', 'what was this?')]);
    const none = await readClaudeChatPage(file, marked);
    expect(results(none.entries)).toMatchObject([{ toolUseId: 'ghost', output: 'what was this?', callUnknown: true }]);
  });

  it('is left unmarked when its call, found earlier, touched nothing secret', async () => {
    writeJsonl(file, [claude.call('t1', 'Read', { file_path: '/proj/src/a.ts' }), claude.result('t1', 'x'), claude.user('later')]);
    const { entries } = await readClaudeChatPage(file, { ...marked, limit: 2 });
    expect(results(entries)[0]).not.toHaveProperty('secret');
    expect(results(entries)[0]).not.toHaveProperty('callUnknown');
  });
});

describe('Codex calls', () => {
  it('marks cmd, a local shell action, script tools, patches inside scripts and file changes', async () => {
    writeJsonl(file, [
      codex.meta(),
      codex.functionCall('c1', 'exec_command', { cmd: 'cat .env', workdir: '/proj' }),
      codex.functionOutput('c1', 'DB_PASSWORD=hunter2'),
      { timestamp: '2026-10-16T10:00:00.000Z', type: 'response_item', payload: { type: 'local_shell_call', call_id: 'c2', action: { type: 'exec', command: ['bash', '-lc', 'cat ~/.ssh/config'] } } },
      codex.functionOutput('c2', 'Host secret-box'),
      codex.customCall('c3', 'exec', 'const r = await tools.exec_command({ cmd: "grep KEY .env.local" }); text(r);'),
      codex.customOutput('c3', [{ type: 'input_text', text: 'Script completed\nKEY=x' }]),
      codex.functionCall('c4', 'js', { code: 'await fs.readFile("config/credentials.json")', title: 'Read' }),
      codex.functionOutput('c4', 'client_secret=zzz'),
      codex.customCall('c5', 'exec', 'await tools.apply_patch("*** Begin Patch\\n*** Add File: /proj/.env\\n+SECRET=1\\n*** End Patch\\n");'),
      codex.customOutput('c5', [{ type: 'input_text', text: 'Script completed' }]),
      codex.fileChange('fc1', { '/proj/.env': { type: 'add', content: 'API=sk\n' }, '/proj/a.ts': { type: 'add', content: 'x\n' } }),
      codex.functionCall('c6', 'exec_command', { cmd: 'ls src' }),
      codex.functionOutput('c6', 'app.ts'),
    ]);
    const { entries } = await readCodexChatPage(file, marked);
    const resultMarks = Object.fromEntries(results(entries).map((r) => [r.toolUseId, r.secret === true]));
    expect(resultMarks).toEqual({ c1: true, c2: true, c3: true, c4: true, c5: true, fc1: true, c6: false });
    const byId = Object.fromEntries(uses(entries).map((u) => [u.id, u]));
    expect(byId.c5).toMatchObject({ secret: true, secretInput: true, editPaths: ['/proj/.env'] });
    expect(byId.fc1).toMatchObject({ secret: true, secretInput: true, editPaths: ['/proj/.env', '/proj/a.ts'] });
    expect(byId.c1).toMatchObject({ secret: true });
    expect(byId.c1).not.toHaveProperty('secretInput');
  });
});

it('reads no further back than the lookback budget, however big the file', async () => {
  // A call 2 MB back with a 64 KB budget: the read stops long before it.
  writeJsonl(file, [claude.call('t1', 'Read', { file_path: '/proj/.env' })]);
  appendFileSync(file, jsonl(Array.from({ length: 2000 }, (_, i) => claude.user(`f${i} ${'y'.repeat(1000)}`))));
  appendJsonl(file, [claude.result('t1', 'K=1')]);
  const { entries } = await readClaudeChatPage(file, { ...marked, limit: 1, scanBytes: 64 * 1024 });
  expect(results(entries)).toMatchObject([{ callUnknown: true }]);
});
