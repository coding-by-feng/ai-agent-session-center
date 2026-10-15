// test/chatCodexTranscript.test.ts — AASC-41: a Codex rollout as chat entries. Synthetic rollouts with the
// structure the installed Codex writes (response_item / event_msg / turn_context / compacted); no real
// rollout is read.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readCodexChatPage } from '../server/chat/codexTranscript.js';
import type { ChatEntry } from '../src/types/chat.js';
import { appendJsonl, codex, tempDir, writeJsonl } from './chatFixtures.js';

let dir = '';
let file = '';

beforeEach(() => {
  dir = tempDir('aasc41-codex-');
  file = join(dir, 'rollout.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bare = (entries: ChatEntry[]) => entries.map(({ key: _k, timestamp: _t, ...rest }) => rest);

async function entriesOf(records: unknown[]): Promise<ChatEntry[]> {
  writeJsonl(file, records);
  return (await readCodexChatPage(file)).entries;
}

const PATCH = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n';

describe('Codex records → chat entries', () => {
  it('maps prompts and replies, and keeps injected context apart from what was typed', async () => {
    const entries = await entriesOf([
      codex.meta(),
      codex.developer('<permissions instructions>never ask</permissions instructions>'),
      codex.user('# AGENTS.md instructions for /proj\n\nBe nice.', '<environment_context>\n  <cwd>/proj</cwd>\n</environment_context>'),
      codex.turnContext('gpt-5.5', 'high'),
      codex.user('add a test'),
      codex.userEcho('add a test'),
      codex.user('<skill>\n<name>tdd</name>\nWrite tests first.\n</skill>'),
      codex.assistant('Working on it.', 'commentary'),
      codex.assistant('Done.'),
      codex.tokenCount(),
    ]);
    expect(bare(entries)).toEqual([
      { kind: 'system', system: 'context', label: 'AGENTS.md', text: '# AGENTS.md instructions for /proj\n\nBe nice.' },
      { kind: 'system', system: 'context', label: 'environment_context', text: '<environment_context>\n  <cwd>/proj</cwd>\n</environment_context>' },
      { kind: 'system', system: 'model', label: 'gpt-5.5 · high' },
      { kind: 'user', text: 'add a test' },
      { kind: 'system', system: 'context', label: 'skill', text: '<skill>\n<name>tdd</name>\nWrite tests first.\n</skill>' },
      { kind: 'assistant', text: 'Working on it.' },
      { kind: 'assistant', text: 'Done.' },
    ]);
  });

  it('counts a prompt’s images without sending them', async () => {
    const entries = await entriesOf([
      codex.userBlocks([
        { type: 'input_text', text: '<image name=[Image #1] path="/tmp/a.png">' },
        { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
        { type: 'input_text', text: '</image>' },
        { type: 'input_text', text: 'what is this?' },
      ]),
    ]);
    expect(bare(entries)).toEqual([{ kind: 'user', text: 'what is this?', images: 1 }]);
    expect(JSON.stringify(entries)).not.toContain('QUJD');
  });

  it('marks reasoning by length only, never sending it', async () => {
    const entries = await entriesOf([codex.reasoning(['**Planning** the fix']), codex.reasoning()]);
    expect(bare(entries)).toEqual([{ kind: 'thinking', length: 20 }, { kind: 'thinking', length: 0 }]);
    expect(JSON.stringify(entries)).not.toContain('Planning');
  });

  it('pairs function calls with their output, and reads an exit code as an error', async () => {
    const entries = await entriesOf([
      codex.functionCall('c1', 'exec_command', { cmd: 'npm test', workdir: '/proj' }),
      codex.functionOutput('c1', JSON.stringify({ output: '1 failed', metadata: { exit_code: 1, duration_seconds: 2 } })),
      codex.functionCall('c2', 'js', { code: 'console.log(1)', title: 'Log' }),
      codex.functionOutput('c2', [{ type: 'input_text', text: 'ok' }, { type: 'input_image', image_url: 'data:image/png;base64,QUJD' }]),
      codex.functionCall('c3', 'odd', 'not json'),
      codex.functionOutput('c3', { content: 'nope', success: false }),
    ]);
    expect(bare(entries)).toEqual([
      { kind: 'tool_use', id: 'c1', name: 'exec_command', input: { cmd: 'npm test', workdir: '/proj' } },
      { kind: 'tool_result', toolUseId: 'c1', isError: true, output: '1 failed', truncated: false },
      { kind: 'tool_use', id: 'c2', name: 'js', input: { code: 'console.log(1)', title: 'Log' } },
      { kind: 'tool_result', toolUseId: 'c2', isError: false, output: 'ok\n[image]', truncated: false },
      { kind: 'tool_use', id: 'c3', name: 'odd', input: 'not json' },
      { kind: 'tool_result', toolUseId: 'c3', isError: true, output: 'nope', truncated: false },
    ]);
  });

  it('keeps apply_patch whole as an edit, and reads a failed script as an error', async () => {
    const big = `*** Begin Patch\n*** Add File: big.txt\n${'+line\n'.repeat(3000)}*** End Patch\n`;
    const entries = await entriesOf([
      codex.customCall('p1', 'apply_patch', PATCH),
      codex.customOutput('p1', 'Success. Updated the following files:\nM src/a.ts'),
      codex.customCall('p2', 'apply_patch', big),
      codex.customCall('x1', 'exec', 'const r = await tools.exec_command({ cmd: "ls" });'),
      codex.customOutput('x1', [{ type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\nboom' }]),
      codex.functionCall('s1', 'shell', { command: ['apply_patch', PATCH], workdir: '/proj' }),
    ]);
    expect(bare(entries)).toEqual([
      { kind: 'tool_use', id: 'p1', name: 'apply_patch', input: PATCH },
      { kind: 'tool_result', toolUseId: 'p1', isError: false, output: 'Success. Updated the following files:\nM src/a.ts', truncated: false },
      { kind: 'tool_use', id: 'p2', name: 'apply_patch', input: big },
      { kind: 'tool_use', id: 'x1', name: 'exec', input: 'const r = await tools.exec_command({ cmd: "ls" });' },
      { kind: 'tool_result', toolUseId: 'x1', isError: true, output: 'Script failed\nWall time 0.1 seconds\nOutput:\nboom', truncated: false },
      { kind: 'tool_use', id: 's1', name: 'apply_patch', input: PATCH },
    ]);
  });

  it('shows a file change Codex reports as an apply_patch edit with its outcome', async () => {
    const changes = {
      '/proj/src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n', move_path: null },
      '/proj/notes.md': { type: 'add', content: '# Notes\n' },
    };
    const entries = await entriesOf([codex.fileChange('fc1', changes), codex.fileChange('fc2', {}, 'failed')]);
    expect(bare(entries)).toEqual([
      { kind: 'tool_use', id: 'fc1', name: 'apply_patch', input: { changes } },
      { kind: 'tool_result', toolUseId: 'fc1', isError: false, output: 'Success', truncated: false },
      { kind: 'tool_use', id: 'fc2', name: 'apply_patch', input: { changes: {} } },
      { kind: 'tool_result', toolUseId: 'fc2', isError: true, output: 'Success', truncated: false },
    ]);
  });

  it('turns update_plan into a todo list and spawn_agent into a subagent', async () => {
    const entries = await entriesOf([
      codex.functionCall('u1', 'update_plan', { explanation: 'x', plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'in_progress' }] }),
      codex.functionCall('a1', 'spawn_agent', { task_name: 'scout', message: 'Find the callers', fork_turns: 'none' }),
      codex.functionOutput('a1', JSON.stringify({ task_name: 'scout' })),
    ]);
    expect(bare(entries)).toEqual([
      { kind: 'todo', id: 'u1', items: [{ text: 'Read', status: 'completed' }, { text: 'Fix', status: 'in_progress' }] },
      { kind: 'subagent', id: 'a1', description: 'scout', prompt: 'Find the callers' },
      { kind: 'tool_result', toolUseId: 'a1', isError: false, output: '{"task_name":"scout"}', truncated: false },
    ]);
  });

  it('marks compaction, cancels and a resumed process', async () => {
    const entries = await entriesOf([
      codex.meta(),
      codex.user('go'),
      codex.aborted(),
      codex.compacted(),
      codex.meta(),
    ]);
    expect(bare(entries)).toEqual([
      { kind: 'user', text: 'go' },
      { kind: 'system', system: 'cancelled' },
      { kind: 'system', system: 'compacted' },
      { kind: 'system', system: 'resumed' },
    ]);
  });

  it('caps text and tool output like the Claude reader', async () => {
    const entries = await entriesOf([
      codex.assistant('x'.repeat(20_000)),
      codex.functionCall('c', 'exec_command', { cmd: 'y'.repeat(5000) }),
      codex.functionOutput('c', 'z'.repeat(5000)),
    ]);
    expect(entries[0]).toMatchObject({ kind: 'assistant', truncated: true });
    expect(entries[1]).toMatchObject({ kind: 'tool_use', inputTruncated: true });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', truncated: true });
    expect((entries[2] as { output: string }).output.length).toBe(4096);
  });
});

describe('paging a rollout', () => {
  it('opens on the newest page and follows new records with after', async () => {
    writeJsonl(file, [codex.meta(), ...Array.from({ length: 250 }, (_, i) => codex.user(`p${i}`))]);
    const page = await readCodexChatPage(file);
    expect(page.entries).toHaveLength(200);
    expect(page.entries[0]).toMatchObject({ text: 'p50' });
    expect(page.hasMore).toBe(true);
    appendJsonl(file, [codex.assistant('new reply')]);
    const next = await readCodexChatPage(file, { after: page.after });
    expect(bare(next.entries)).toEqual([{ kind: 'assistant', text: 'new reply' }]);
  });
});
