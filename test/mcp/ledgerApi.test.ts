// test/mcp/ledgerApi.test.ts — the ledger's three /api calls (server/mcp/ledgerApi.ts), made over the central's own
// loopback client: the prompt it sends, how its send went (and why the route stopped it), and the task's turn it reads
// back from the chat route, paged back to the task's own prompt.
import { describe, expect, it, vi } from 'vitest';
import { CHAT_PAGES_MAX, ledgerApi } from '../../server/mcp/ledgerApi.js';
import { envelope, fail, fakeClient, NOW, ok, type Answer } from './toolHarness.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

function api(routes: Record<string, Answer> = {}) {
  const client = fakeClient(routes);
  const clientFor = vi.fn((centralId: string) => (centralId === 'gone' ? null : client));
  return { client, clientFor, deps: ledgerApi(clientFor) };
}

const chat = (entries: unknown[], over: Record<string, unknown> = {}) =>
  envelope({ entries, before: 'b', after: 'a', cli: 'claude', hasMore: false, ...over });

describe('submit', () => {
  it('posts the prompt as now, with its key, as the central', async () => {
    const { client, clientFor, deps } = api({
      'POST /sessions/w1/prompt': ok({ success: true, data: { accepted: true, key: 'mcp-c-task-T1' } }, 202),
    });

    const answer = await deps.submit('w1', '[AASC · task T1 from ★ global] x', 'mcp-c-task-T1', 'c1');

    expect(answer).toEqual({ accepted: true, error: null });
    expect(clientFor).toHaveBeenCalledWith('c1');
    expect(client.calls).toEqual([
      {
        method: 'POST',
        path: '/sessions/w1/prompt',
        body: { text: '[AASC · task T1 from ★ global] x', key: 'mcp-c-task-T1', mode: 'now' },
      },
    ]);
  });

  it('puts the session id in the path as one segment', async () => {
    const { client, deps } = api();
    await deps.submit('a/b?c', 't', 'mcp-c-task-T1', 'c1');
    expect(client.calls[0].path).toBe('/sessions/a%2Fb%3Fc/prompt');
  });

  it('answers a refusal with the route’s code and words', async () => {
    const busy: Answer = {
      ok: false,
      status: 409,
      data: { success: false, code: 'busy', error: 'Another prompt is already waiting to be typed here; try again in a moment' },
      error: 'Another prompt is already waiting to be typed here; try again in a moment',
    };
    const { deps } = api({ 'POST /sessions/w1/prompt': busy });

    expect(await deps.submit('w1', 't', 'mcp-c-task-T1', 'c1')).toEqual({
      accepted: false,
      error: 'busy: Another prompt is already waiting to be typed here; try again in a moment',
    });
  });

  it('says AASC could not be reached, in fixed words, when no answer came', async () => {
    const { deps } = api({
      'POST /sessions/w1/prompt': { ok: false, status: 0, data: null, error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:3333' },
    });

    const answer = await deps.submit('w1', 't', 'mcp-c-task-T1', 'c1');

    expect(answer).toEqual({ accepted: false, error: 'AASC could not be reached.' });
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('ECONNREFUSED'));
  });

  it('refuses for a central that is no longer live, calling nothing', async () => {
    const { client, deps } = api();
    expect(await deps.submit('w1', 't', 'mcp-c-task-T1', 'gone')).toEqual({ accepted: false, error: 'The central is no longer live.' });
    expect(client.calls).toEqual([]);
  });
});

describe('promptOutcome', () => {
  it('answers how the send ended, and null while it runs', async () => {
    let state = 'pending';
    const { client, deps } = api({ 'GET /sessions/w1/prompt/mcp-c-task-T1': () => envelope({ key: 'mcp-c-task-T1', state }) });

    expect(await deps.promptOutcome('w1', 'mcp-c-task-T1', 'c1')).toBeNull();
    for (const outcome of ['submitted', 'unconfirmed', 'stopped', 'gave-up', 'failed']) {
      state = outcome;
      expect(await deps.promptOutcome('w1', 'mcp-c-task-T1', 'c1')).toEqual({ state: outcome });
    }
    expect(client.calls[0]).toEqual({ method: 'GET', path: '/sessions/w1/prompt/mcp-c-task-T1' });
  });

  it('carries why the route stopped a central’s send, and only a reason it knows (Ruling 51)', async () => {
    const { deps } = api({
      'GET /sessions/w1/prompt/k-hands-1': envelope({ key: 'k-hands-1', state: 'stopped', stoppedBy: 'hands-off' }),
      'GET /sessions/w1/prompt/k-person-1': envelope({ key: 'k-person-1', state: 'stopped', stoppedBy: 'person' }),
      'GET /sessions/w1/prompt/k-odd-1': envelope({ key: 'k-odd-1', state: 'stopped', stoppedBy: 'a gremlin' }),
    });

    expect(await deps.promptOutcome('w1', 'k-hands-1', 'c1')).toEqual({ state: 'stopped', stoppedBy: 'hands-off' });
    expect(await deps.promptOutcome('w1', 'k-person-1', 'c1')).toEqual({ state: 'stopped', stoppedBy: 'person' });
    expect(await deps.promptOutcome('w1', 'k-odd-1', 'c1')).toEqual({ state: 'stopped' });
  });

  it('is null for a key the route no longer holds, a state it does not know, and a central that is gone', async () => {
    const { deps } = api({ 'GET /sessions/w1/prompt/k-weird-1': envelope({ key: 'k-weird-1', state: 'exploded' }) });

    expect(await deps.promptOutcome('w1', 'k-expired-1', 'c1')).toBeNull();
    expect(await deps.promptOutcome('w1', 'k-weird-1', 'c1')).toBeNull();
    expect(await deps.promptOutcome('w1', 'k-weird-1', 'gone')).toBeNull();
  });
});

describe('readChat', () => {
  const head = '[AASC · task T1 from ';
  const own = { kind: 'user', key: '1:0', timestamp: NOW + 10, text: `${head}★ global] the task` };
  const cap = { assistantCap: '20000' };
  /** A chat route that answers each `before` cursor with its own page (no cursor: the newest). */
  const paged =
    (pages: Record<string, ReturnType<typeof chat>>): Answer =>
    (call) =>
      pages[(call.query as { before?: string } | undefined)?.before ?? 'newest'] ?? fail(404, 'Not found');

  it('reads the newest page with the answer’s cap, and stops once it holds the task’s own prompt', async () => {
    const { client, deps } = api({
      'GET /sessions/w1/chat': chat([own, { kind: 'assistant', key: '1:1', timestamp: NOW + 20, text: 'Done.' }], { hasMore: true, before: 'p0' }),
    });

    const entries = await deps.readChat('w1', head, NOW, 'c1');

    expect(entries.map((e) => e.key)).toEqual(['1:0', '1:1']);
    expect(client.calls).toEqual([{ method: 'GET', path: '/sessions/w1/chat', query: cap }]);
  });

  it('pages back, oldest first, until it reaches the task’s prompt', async () => {
    const { client, deps } = api({
      'GET /sessions/w1/chat': paged({
        newest: chat([{ kind: 'assistant', key: '3:0', timestamp: NOW + 30, text: 'final' }], { hasMore: true, before: 'p2' }),
        p2: chat([{ kind: 'tool_use', key: '2:0', timestamp: NOW + 20, id: 't', name: 'Bash', input: {} }], { hasMore: true, before: 'p1' }),
        p1: chat([own], { hasMore: true, before: 'p0' }),
      }),
    });

    const entries = await deps.readChat('w1', head, NOW, 'c1');

    expect(entries.map((e) => e.key)).toEqual(['1:0', '2:0', '3:0']);
    expect(client.calls.map((c) => c.query)).toEqual([cap, { ...cap, before: 'p2' }, { ...cap, before: 'p1' }]);
  });

  it('stops at its send time, at the oldest page, and after 5 pages', async () => {
    const older = { kind: 'assistant', key: '0:0', timestamp: NOW - 1, text: 'from before the task' };
    const endless: Answer = () => chat([{ kind: 'assistant', key: '9:0', timestamp: NOW + 5, text: 'more' }], { hasMore: true, before: 'next' });
    const { client, deps } = api({
      'GET /sessions/w1/chat': chat([older, { kind: 'assistant', key: '0:1', timestamp: NOW + 5, text: 'after' }], { hasMore: true, before: 'p' }),
      'GET /sessions/w2/chat': chat([{ kind: 'assistant', key: '0:1', timestamp: NOW + 5, text: 'all there is' }], { hasMore: false }),
      'GET /sessions/w3/chat': endless,
    });

    await deps.readChat('w1', head, NOW, 'c1');
    await deps.readChat('w2', head, NOW, 'c1');
    await deps.readChat('w3', head, NOW, 'c1');

    const callsTo = (id: string) => client.calls.filter((c) => c.path === `/sessions/${id}/chat`).length;
    expect([callsTo('w1'), callsTo('w2'), callsTo('w3')]).toEqual([1, 1, CHAT_PAGES_MAX]);
    expect(CHAT_PAGES_MAX).toBe(5);
  });

  it('starts over on a reset page (a /clear between pages): what it read before was the old file’s', async () => {
    const { deps } = api({
      'GET /sessions/w1/chat': paged({
        newest: chat([{ kind: 'assistant', key: '5:0', timestamp: NOW + 50, text: 'old file' }], { hasMore: true, before: 'p1' }),
        p1: chat([{ kind: 'user', key: '0:0', timestamp: NOW + 60, text: 'new file' }], { hasMore: true, before: 'q', reset: true }),
      }),
    });

    expect((await deps.readChat('w1', head, NOW, 'c1')).map((e) => e.key)).toEqual(['0:0']);
  });

  it('answers no entries for a conversation AASC cannot read', async () => {
    const { deps } = api({ 'GET /sessions/w1/chat': envelope({ entries: [], before: null, after: null, cli: null, hasMore: false }) });

    expect(await deps.readChat('w1', head, NOW, 'c1')).toEqual([]);
  });

  it('throws when the route fails or the central is gone, so the ledger can read again on its next tick', async () => {
    const { client, deps } = api({ 'GET /sessions/w1/chat': fail(500, 'Could not read the conversation') });

    await expect(deps.readChat('w1', head, NOW, 'c1')).rejects.toThrow();
    await expect(deps.readChat('w1', head, NOW, 'gone')).rejects.toThrow();
    expect(client.calls).toHaveLength(1);
  });
});
