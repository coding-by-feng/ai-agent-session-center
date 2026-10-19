// buildChatItems.test.ts — the phone chat's item model (AASC-41), from Claude and
// Codex entry streams: tool_use/tool_result pairing, consecutive calls folded into
// one row with failures (and edits) kept visible, thinking merged, the latest plan
// as a card, subagent cards with their report, session events as dividers, queued
// prompts at the end, redacted inputs shown plainly, and one search predicate.
import { describe, it, expect } from 'vitest';
import type { ChatEntry } from '@/types/chat';
import { buildChatItems, findMatches, type ChatItem, type ToolItem, type ToolGroupItem } from './buildChatItems';

const T0 = Date.parse('2026-10-15T10:00:00.000Z');

/** Entries with keys and times in order (one second apart unless `at` says otherwise). */
function stream(...drafts: Array<Record<string, unknown>>): ChatEntry[] {
  return drafts.map((d, i) => ({ key: `${i * 100}:0`, timestamp: T0 + i * 1000, ...d }) as ChatEntry);
}

const kinds = (items: ChatItem[]) => items.map((i) => i.kind);

function claudeEntries(): ChatEntry[] {
  return stream(
    { kind: 'user', text: 'Centre the minimize icon’s bar', images: 1 },
    { kind: 'thinking', length: 400, durationMs: 7000 },
    { kind: 'thinking', length: 100, durationMs: 5000 },
    { kind: 'assistant', text: 'I’ll check the icon’s SVG first.' },
    { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/src/components/ui/icons.tsx' } },
    { kind: 'tool_result', toolUseId: 't1', isError: false, output: '1\texport …', truncated: false },
    { kind: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'MinimizeIcon' } },
    { kind: 'tool_result', toolUseId: 't2', isError: false, output: 'Found 4 files\na\nb\nc\nd', truncated: false },
    { kind: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/p/src/components/ui/icons.tsx', old_string: '<rect y="10.5" />', new_string: '<rect y="7" />' } },
    { kind: 'tool_result', toolUseId: 't3', isError: false, output: 'The file has been updated', truncated: false },
    { kind: 'tool_use', id: 't4', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } },
    { kind: 'tool_result', toolUseId: 't4', isError: false, output: 'ok', truncated: false, timestamp: T0 + 10_000 + 42_000 },
    { kind: 'tool_use', id: 't5', name: 'Bash', input: { command: 'npm run lint' } },
    { kind: 'tool_result', toolUseId: 't5', isError: true, output: '1 error', truncated: false },
    { kind: 'tool_use', id: 't6', name: 'Bash', input: { command: 'npm run build' } },
    { kind: 'tool_result', toolUseId: 't6', isError: false, output: 'built', truncated: false },
    { kind: 'tool_use', id: 't7', name: 'Bash', input: { command: 'git status' } },
    { kind: 'tool_result', toolUseId: 't7', isError: false, output: 'clean', truncated: false },
    { kind: 'todo', id: 't8', items: [{ text: 'Read', status: 'completed' }, { text: 'Fix', status: 'completed' }, { text: 'Test', status: 'in_progress' }] },
    { kind: 'tool_result', toolUseId: 't8', isError: false, output: 'Todos have been modified', truncated: false },
    { kind: 'subagent', id: 't9', description: 'Explore the phone UI', agentType: 'Explore', prompt: 'Look around' },
    { kind: 'tool_result', toolUseId: 't9', isError: false, output: 'The phone UI lives in src/components/mobile.', truncated: false },
    { kind: 'system', system: 'compacted', label: 'auto' },
    { kind: 'assistant', text: 'The bar is centred now.' },
    { kind: 'command', name: '/model', args: 'opus', output: 'Set model to opus' },
    { kind: 'system', system: 'cancelled' },
  );
}

describe('buildChatItems — a Claude session', () => {
  const items = buildChatItems(claudeEntries());

  it('lays the turn out in order, folding consecutive calls but not edits or failures', () => {
    expect(kinds(items)).toEqual([
      'user', 'thinking', 'assistant',
      'tool-group', // Read + Grep
      'tool', // Edit (an edit always shows)
      'tool', // npm test
      'tool', // npm run lint — failed, outside any group
      'tool-group', // build + git status
      'todo', 'subagent', 'divider', 'assistant', 'command', 'divider',
    ]);
  });

  it('keeps the prompt’s text and image count', () => {
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Centre the minimize icon’s bar', images: 1 });
  });

  it('merges back-to-back thinking into one “Thought for 12 s” row', () => {
    expect(items[1]).toMatchObject({ kind: 'thinking', durationMs: 12_000, length: 500 });
  });

  it('pairs each call with its result and summarises a group', () => {
    const group = items[3] as ToolGroupItem;
    expect(group.summary).toBe('Read 1 file, searched once');
    expect(group.calls.map((c) => c.call.id)).toEqual(['t1', 't2']);
    expect(group.key).toBe(`group:${group.calls[0].key}`);
    expect(group.calls[1].call).toMatchObject({ status: 'done', verb: 'Searched', target: '“MinimizeIcon”', meta: '4 files' });
    expect((items[7] as ToolGroupItem).summary).toBe('Ran 2 commands');
  });

  it('shows an edit with its file and counts', () => {
    expect((items[4] as ToolItem).call).toMatchObject({ verb: 'Edited', target: 'icons.tsx', meta: '+1 −1', category: 'edit' });
  });

  it('times a command from its call to its result', () => {
    expect((items[5] as ToolItem).call).toMatchObject({ verb: 'Ran', target: 'npm test', status: 'done', durationMs: 42_000 });
  });

  it('keeps a failed call visible on its own', () => {
    expect((items[6] as ToolItem).call).toMatchObject({ status: 'failed', target: 'npm run lint' });
    expect((items[6] as ToolItem).call.result?.output).toBe('1 error');
  });

  it('marks the latest plan and counts what is done', () => {
    expect(items[8]).toMatchObject({ kind: 'todo', latest: true, done: 2, total: 3 });
  });

  it('gives a subagent its report', () => {
    expect(items[9]).toMatchObject({ kind: 'subagent', description: 'Explore the phone UI', agentType: 'Explore', status: 'done' });
    expect(items[9].kind === 'subagent' && items[9].report?.output).toContain('src/components/mobile');
  });

  it('marks only the last reply of a turn as the answer', () => {
    const replies = items.filter((i) => i.kind === 'assistant');
    expect(replies.map((r) => r.kind === 'assistant' && r.isAnswer)).toEqual([false, true]);
  });

  it('turns session events into dividers with plain words', () => {
    expect(items[10]).toMatchObject({ kind: 'divider', label: 'Context compacted · auto' });
    expect(items[13]).toMatchObject({ kind: 'divider', label: 'You stopped this turn' });
    expect(items[12]).toMatchObject({ kind: 'command', name: '/model', args: 'opus', output: 'Set model to opus' });
  });

  it('only marks the newest of several plans as the latest', () => {
    const two = buildChatItems(stream(
      { kind: 'todo', id: 'a', items: [{ text: 'x', status: 'pending' }] },
      { kind: 'assistant', text: 'hm' },
      { kind: 'todo', id: 'b', items: [{ text: 'x', status: 'completed' }] },
    ));
    expect(two.filter((i) => i.kind === 'todo').map((i) => i.kind === 'todo' && i.latest)).toEqual([false, true]);
  });
});

describe('buildChatItems — a Codex session', () => {
  const items = buildChatItems(stream(
    { kind: 'system', system: 'context', label: 'AGENTS.md', text: '# AGENTS.md\nrules' },
    { kind: 'system', system: 'context', label: 'environment_context', text: '<environment_context>…' },
    { kind: 'system', system: 'model', label: 'gpt-5.5 · high' },
    { kind: 'user', text: 'Fix the failing test' },
    { kind: 'thinking', length: 0 },
    { kind: 'tool_use', id: 'c1', name: 'shell', input: { command: ['bash', '-lc', 'npm test'], workdir: '/p' } },
    { kind: 'tool_result', toolUseId: 'c1', isError: true, output: 'FAIL a.test.ts', truncated: false },
    { kind: 'tool_use', id: 'c2', name: 'exec_command', input: { cmd: 'rg -n foo src' } },
    { kind: 'tool_result', toolUseId: 'c2', isError: false, output: 'src/a.ts:3:foo', truncated: false },
    { kind: 'tool_use', id: 'c3', name: 'exec_command', input: { cmd: 'sed -n 1,40p src/a.ts' } },
    { kind: 'tool_result', toolUseId: 'c3', isError: false, output: '…', truncated: false },
    { kind: 'tool_use', id: 'c4', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-foo\n+bar\n*** End Patch' },
    { kind: 'tool_result', toolUseId: 'c4', isError: false, output: 'Success', truncated: false },
    { kind: 'todo', id: 'c5', items: [{ text: 'Fix', status: 'completed' }] },
    { kind: 'system', system: 'model', label: 'gpt-5.5 · high' },
    { kind: 'assistant', text: 'Fixed: `foo` is `bar` now.' },
    { kind: 'system', system: 'model', label: 'gpt-5.5 · medium' },
  ));

  it('lays out a Codex turn the same way', () => {
    expect(kinds(items)).toEqual(['divider', 'divider', 'user', 'thinking', 'tool', 'tool-group', 'tool', 'todo', 'assistant', 'divider']);
  });

  it('folds back-to-back context into one divider and drops a repeated model row', () => {
    expect(items[0]).toMatchObject({ kind: 'divider', system: 'context', label: 'Added context · AGENTS.md, environment_context' });
    expect(items[1]).toMatchObject({ label: 'Model · gpt-5.5 · high' });
    expect(items[9]).toMatchObject({ label: 'Model · gpt-5.5 · medium' });
  });

  it('reads a shell argv as the command it ran', () => {
    expect((items[4] as ToolItem).call).toMatchObject({ verb: 'Ran', target: 'npm test', status: 'failed' });
    expect((items[5] as ToolGroupItem).summary).toBe('Ran 2 commands');
  });

  it('shows apply_patch as an edit of its file', () => {
    expect((items[6] as ToolItem).call).toMatchObject({ verb: 'Edited', target: 'a.ts', meta: '+1 −1' });
  });

  it('says “Thought” when the CLI kept the length and duration to itself', () => {
    expect(items[3]).toMatchObject({ kind: 'thinking', length: 0 });
  });
});

describe('buildChatItems — live, partial and redacted', () => {
  it('leaves a running call outside the group while the session works', () => {
    const entries = stream(
      { kind: 'user', text: 'go' },
      { kind: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.ts' } },
      { kind: 'tool_result', toolUseId: 'a', isError: false, output: 'x', truncated: false },
      { kind: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'b.ts' } },
      { kind: 'tool_result', toolUseId: 'b', isError: false, output: 'y', truncated: false },
      { kind: 'tool_use', id: 'c', name: 'Bash', input: { command: 'npm test' } },
    );
    const live = buildChatItems(entries, { live: true });
    expect(kinds(live)).toEqual(['user', 'tool-group', 'tool']);
    expect((live[2] as ToolItem).call.status).toBe('running');
    const ended = buildChatItems(entries, { live: false });
    expect((ended[2] as ToolItem).call.status).toBe('no-result');
  });

  it('says an open call waits for you while the session waits for an approval', () => {
    const entries = stream({ kind: 'user', text: 'go' }, { kind: 'tool_use', id: 'c', name: 'Bash', input: { command: 'rm -rf dist' } });
    expect((buildChatItems(entries, { live: true, awaiting: true })[1] as ToolItem).call.status).toBe('waiting');
  });

  it('never folds a proposed plan or a question', () => {
    const items = buildChatItems(stream(
      { kind: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a' } },
      { kind: 'tool_result', toolUseId: 'a', isError: false, output: 'x', truncated: false },
      { kind: 'tool_use', id: 'p', name: 'ExitPlanMode', input: { plan: '# Plan' } },
      { kind: 'tool_result', toolUseId: 'p', isError: false, output: 'ok', truncated: false },
      { kind: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'b' } },
      { kind: 'tool_result', toolUseId: 'b', isError: false, output: 'y', truncated: false },
    ));
    expect(kinds(items)).toEqual(['tool', 'tool', 'tool']);
  });

  it('blanks the output of a secret file’s call even when the server sent it', () => {
    const items = buildChatItems(stream(
      { kind: 'tool_use', id: 'r', name: 'Read', input: { file_path: '.env', redacted: true } },
      { kind: 'tool_result', toolUseId: 'r', isError: false, output: 'API_KEY=leaked', truncated: false },
    ));
    expect((items[0] as ToolItem).call.result?.output).toBe('[Hidden on phones: this touched a secret file]');
    expect(items[0].searchText).not.toContain('leaked');
  });

  it('marks the newest answer as the latest, which alone shows its actions (Oct 20 2026)', () => {
    const entries = stream(
      { kind: 'user', text: 'one' }, { kind: 'assistant', text: 'First answer.' },
      { kind: 'user', text: 'two' }, { kind: 'assistant', text: 'Second answer.' },
    );
    const answers = buildChatItems(entries).filter((i) => i.kind === 'assistant');
    expect(answers.map((a) => a.kind === 'assistant' && [a.isAnswer, a.latestAnswer])).toEqual([[true, false], [true, true]]);
    // While a new turn runs, the previous turn's answer is still the latest one.
    const live = buildChatItems([...entries, ...stream({ kind: 'user', text: 'three' }, { kind: 'assistant', text: 'Working on it.' })], { live: true });
    expect(live.filter((i) => i.kind === 'assistant').map((a) => a.kind === 'assistant' && a.latestAnswer)).toEqual([false, true, false]);
  });

  it('marks no answer in a turn still under way', () => {
    const entries = stream({ kind: 'user', text: 'go' }, { kind: 'assistant', text: 'Starting.' }, { kind: 'tool_use', id: 'q', name: 'Bash', input: { command: 'ls' } });
    expect(buildChatItems(entries, { live: true })[1]).toMatchObject({ kind: 'assistant', isAnswer: false });
    expect(buildChatItems(entries, { live: false })[1]).toMatchObject({ kind: 'assistant', isAnswer: true });
  });

  it('shows a command that only names a secret file by the server’s note, its words hidden', () => {
    const items = buildChatItems(stream(
      { kind: 'tool_use', id: 'h', name: 'Bash', input: { redacted: true, note: 'Ran a command that touches a secret file' }, secret: true },
      { kind: 'tool_result', toolUseId: 'h', isError: false, output: '[Hidden on phones: this touched a secret file]', truncated: false, secret: true },
    ));
    expect((items[0] as ToolItem).call).toMatchObject({
      verb: 'Ran a command that touches a secret file', target: '', command: null, redacted: true, secret: true, category: 'command',
    });
  });

  it('marks a call that touched a secret file, keeping what the server chose to send', () => {
    const items = buildChatItems(stream(
      { kind: 'tool_use', id: 'm', name: 'Read', input: { file_path: '.env' }, secret: true, secretInput: true },
      { kind: 'tool_result', toolUseId: 'm', isError: false, output: 'KEY=shown on the Mac', truncated: false, secret: true },
      { kind: 'assistant', text: 'read it' },
      { kind: 'tool_use', id: 'n', name: 'Read', input: { file_path: 'a.ts' } },
      { kind: 'tool_result', toolUseId: 'n', isError: false, output: 'x', truncated: false },
    ));
    expect((items[0] as ToolItem).call).toMatchObject({ secret: true, redacted: false });
    expect((items[0] as ToolItem).call.result?.output).toBe('KEY=shown on the Mac');
    expect((items[2] as ToolItem).call.secret).toBe(false);
  });

  it('changes the signature of only the item whose result arrived', () => {
    const base = stream(
      { kind: 'assistant', text: 'one' },
      { kind: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
    );
    const before = buildChatItems(base, { live: true });
    const after = buildChatItems([...base, { key: '900:0', timestamp: T0 + 9000, kind: 'tool_result', toolUseId: 'a', isError: false, output: 'x', truncated: false }], { live: true });
    expect(after[0].sig).toBe(before[0].sig);
    expect(after[1].sig).not.toBe(before[1].sig);
  });

  it('drops a result whose call is on a page not loaded yet', () => {
    const items = buildChatItems(stream(
      { kind: 'tool_result', toolUseId: 'gone', isError: false, output: 'x', truncated: false },
      { kind: 'assistant', text: 'done' },
    ));
    expect(kinds(items)).toEqual(['assistant']);
  });

  it('shows a call on a secret file plainly, with the phone’s note as its output', () => {
    const items = buildChatItems(stream(
      { kind: 'tool_use', id: 'r', name: 'Read', input: { file_path: '.env', redacted: true } },
      { kind: 'tool_result', toolUseId: 'r', isError: false, output: '[Hidden on phones: this touched a secret file]', truncated: false },
    ));
    expect((items[0] as ToolItem).call).toMatchObject({ verb: 'Read', target: '.env', redacted: true, secret: true });
    expect((items[0] as ToolItem).call.result?.output).toMatch(/Hidden on phones/);
  });

  it('marks a subagent with no report as running while the session works', () => {
    const entries = stream({ kind: 'subagent', id: 's', description: 'Look', prompt: 'p', background: true });
    expect(buildChatItems(entries, { live: true })[0]).toMatchObject({ status: 'running', background: true });
    expect(buildChatItems(entries, { live: false })[0]).toMatchObject({ status: 'no-report' });
  });

  it('ignores an entry kind it doesn’t know', () => {
    expect(buildChatItems(stream({ kind: 'mystery' }, { kind: 'assistant', text: 'hi' })).map((i) => i.kind)).toEqual(['assistant']);
  });
});

describe('buildChatItems — queued prompts', () => {
  it('appends the session’s one-off queued prompts, dimmed, in queue order', () => {
    const items = buildChatItems(stream({ kind: 'assistant', text: 'ok' }), {
      queue: [
        { id: 4, text: 'second', position: 1, images: [{ name: 'a', dataUrl: 'x' }] },
        { id: 1, text: 'next', position: 0 },
        { id: 2, text: 'every hour', position: 2, type: 'loop' },
        { id: 3, text: 'paused', position: 3, disabled: true },
      ],
    });
    expect(items.slice(1)).toMatchObject([
      { kind: 'queued', itemId: 1, text: 'next', order: 1, images: 0 },
      { kind: 'queued', itemId: 4, text: 'second', order: 2, images: 1 },
    ]);
  });
});

describe('findMatches', () => {
  const items = buildChatItems(claudeEntries());

  it('finds items by their visible text, a group by any call in it, case-insensitively', () => {
    const keys = findMatches(items, 'NPM RUN');
    const found = items.filter((i) => keys.includes(i.key)).map((i) => i.kind);
    expect(found).toEqual(['tool', 'tool-group']);
  });

  it('finds prose and prompts, and nothing for a blank query', () => {
    expect(findMatches(items, 'centred').length).toBe(1);
    expect(findMatches(items, 'minimize').length).toBeGreaterThanOrEqual(2);
    expect(findMatches(items, '   ')).toEqual([]);
  });
});
