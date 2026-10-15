import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ConversationEntry } from './transcript';
import {
  buildMessageRows,
  summarizeToolCall,
  finalReply,
  fetchSubagentTranscript,
  mergeLatest,
  formatToolInput,
  type SubagentTranscriptPage,
} from './subagentTranscript';

const reply = (text: string, timestamp: number): ConversationEntry => ({ role: 'assistant', text, timestamp });
const call = (tool: string, input: unknown, timestamp: number, id?: string): ConversationEntry => ({
  role: 'tool_use', tool, input: typeof input === 'string' ? input : JSON.stringify(input), timestamp, ...(id ? { id } : {}),
});
const result = (output: string, timestamp: number, toolUseId?: string, isError = false): ConversationEntry => ({
  role: 'tool_result', output, timestamp, isError, ...(toolUseId ? { toolUseId } : {}),
});

describe('summarizeToolCall', () => {
  it.each([
    ['Bash', { command: 'npm test -- --run', description: 'Run tests' }, 'npm test -- --run'],
    ['Read', { file_path: '/x/src/a.ts', offset: 10 }, '/x/src/a.ts'],
    ['Grep', { pattern: 'agent_id', path: '/x/server' }, 'agent_id in /x/server'],
    ['Grep', { pattern: 'agent_id' }, 'agent_id'],
    ['WebFetch', { url: 'https://example.com', prompt: 'summarize' }, 'https://example.com'],
    ['Edit', { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' }, '/x/a.ts'],
    ['Mystery', { whatever: 'first string wins', n: 2 }, 'first string wins'],
  ])('%s → its one telling field', (tool, input, expected) => {
    expect(summarizeToolCall(tool, JSON.stringify(input))).toBe(expected);
  });

  it('collapses a multi-line command onto one line', () => {
    expect(summarizeToolCall('Bash', JSON.stringify({ command: 'cd /x &&\n  npm test' }))).toBe('cd /x && npm test');
  });

  it('still finds the field in input the server cut short (not valid JSON any more)', () => {
    const cut = `${JSON.stringify({ command: 'echo "hi" && ls', description: 'x'.repeat(50) }).slice(0, 60)}…`;
    expect(summarizeToolCall('Bash', cut)).toBe('echo "hi" && ls');
  });

  it('falls back to the raw text', () => {
    expect(summarizeToolCall('Bash', 'not json at all')).toBe('not json at all');
    expect(summarizeToolCall('Bash', '')).toBe('');
  });
});

describe('formatToolInput', () => {
  it('lays a call\'s fields out one per line, strings unescaped', () => {
    expect(formatToolInput(JSON.stringify({ command: 'cd /x &&\n  npm test', timeout: 5000, opts: { a: 1 } })))
      .toBe('command: cd /x &&\n  npm test\ntimeout: 5000\nopts: {"a":1}');
  });
  it('leaves input that is not a JSON object as it is (a cut one too)', () => {
    expect(formatToolInput('{"command":"ls…')).toBe('{"command":"ls…');
    expect(formatToolInput('[1,2]')).toBe('[1,2]');
  });
});

describe('buildMessageRows', () => {
  it('pairs each result with its call by id, even when parallel results arrive out of order', () => {
    const rows = buildMessageRows([
      call('Grep', { pattern: 'a' }, 1, 't1'),
      call('Grep', { pattern: 'b' }, 1, 't2'),
      result('b hits', 2, 't2'),
      result('a failed', 2, 't1', true),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'tool', key: 'tool:t1', summary: 'a', output: 'a failed', failed: true }),
      expect.objectContaining({ kind: 'tool', key: 'tool:t2', summary: 'b', output: 'b hits', failed: false }),
    ]);
  });

  it('pairs id-less results with the oldest unanswered id-less call', () => {
    const rows = buildMessageRows([call('Read', { file_path: '/a' }, 1), call('Read', { file_path: '/b' }, 1), result('A', 2), result('B', 2)]);
    expect(rows.map((r) => (r.kind === 'tool' ? r.output : null))).toEqual(['A', 'B']);
  });

  it('a call still running has no output yet', () => {
    const [row] = buildMessageRows([call('Bash', { command: 'sleep 9' }, 1, 't1')]);
    expect(row).toMatchObject({ kind: 'tool', output: null, failed: false });
  });

  it('a result whose call is on an earlier page stands on its own', () => {
    expect(buildMessageRows([result('orphan', 2, 'gone')])).toEqual([
      expect.objectContaining({ kind: 'result', output: 'orphan', failed: false }),
    ]);
  });

  it('keeps replies and messages in order, and marks text the harness injected', () => {
    const rows = buildMessageRows([
      reply('Looking now.', 1),
      { role: 'user', text: 'Also check the tests', timestamp: 2 },
      { role: 'user', text: '<system-reminder>be brief</system-reminder>', timestamp: 3 },
      { role: 'event', eventType: 'x', detail: '', timestamp: 4 },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'reply', text: 'Looking now.' }),
      expect.objectContaining({ kind: 'message', text: 'Also check the tests', injected: false }),
      expect.objectContaining({ kind: 'message', injected: true }),
    ]);
  });

  it('gives every row a key that survives older entries being added in front', () => {
    const later = [reply('two', 20), call('Bash', { command: 'ls' }, 21, 't9')];
    const before = buildMessageRows(later).map((r) => r.key);
    const after = buildMessageRows([reply('one', 10), ...later]).map((r) => r.key);
    expect(after.slice(1)).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
  });
});

describe('finalReply', () => {
  it('is the last thing the agent said', () => {
    expect(finalReply([reply('first', 1), call('Bash', {}, 2), reply('All done.', 3), result('x', 4)])).toBe('All done.');
  });
  it('is null when it never said anything', () => {
    expect(finalReply([call('Bash', {}, 2)])).toBeNull();
  });
});

describe('mergeLatest', () => {
  const page = (over: Partial<SubagentTranscriptPage>): SubagentTranscriptPage => ({
    task: 't', entries: [], start: 100, hasEarlier: true, ...over,
  });

  it('replaces the newest page and keeps older pages loaded above it', () => {
    const view = { older: [reply('old', 1)], olderStart: 10, olderHasEarlier: true, latest: page({ entries: [reply('a', 5)] }) };
    const next = mergeLatest(view, page({ entries: [reply('a', 5), reply('b', 6)] }));
    expect(next.older).toBe(view.older);
    expect(next.latest.entries).toHaveLength(2);
  });

  it('drops the older pages when the server had to reset to the newest page', () => {
    const view = { older: [reply('old', 1)], olderStart: 10, olderHasEarlier: true, latest: page({}) };
    const next = mergeLatest(view, page({ reset: true, start: 900 }));
    expect(next.older).toEqual([]);
    expect(next.olderStart).toBeNull();
  });
});

describe('fetchSubagentTranscript', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the run under its session, with the paging offset', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { task: 'x', entries: [], start: 0, hasEarlier: false } })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchSubagentTranscript('s/1', 'a1', { before: 42 });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s%2F1/subagents/a1/transcript?before=42', expect.anything());
    expect(res).toEqual({ ok: true, page: { task: 'x', entries: [], start: 0, hasEarlier: false } });
  });

  it('reports "no transcript" as a page of null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: null }))));
    expect(await fetchSubagentTranscript('s', 'a1')).toEqual({ ok: true, page: null });
  });

  it('turns a refusal or a network failure into an error, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: 'Subagent not found' }), { status: 404 })));
    expect(await fetchSubagentTranscript('s', 'a1')).toEqual({ ok: false, error: 'Subagent not found' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await fetchSubagentTranscript('s', 'a1')).toEqual({ ok: false, error: 'Failed to fetch' });
  });
});
