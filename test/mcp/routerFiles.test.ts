// test/mcp/routerFiles.test.ts — how the router uses what a session edited (GET /sessions/:id/changes) and which sessions
// it considers at all. The edited files refine the task-words term, but only for the best eight candidates that no other
// text matched: the route reads a transcript, so it is asked sparingly, and its failing costs nothing.
import { describe, expect, it, vi } from 'vitest';
import { explain } from '../../server/mcp/router.js';
import { envelope, fail, makeSession, NOW, ok, type CtxOptions } from './toolHarness.js';
import { A, AGENT, B, C, GLOBAL, MIN, ROUTES, SITE, go, idsOf, reuseOf, withContext, worker } from './routerFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const changes = (...paths: string[]) =>
  envelope({ files: paths.map((path) => ({ path, added: 3, removed: 1, lastAt: NOW })), total: { added: 3, removed: 1 }, cli: 'claude' });

/** The session ids whose edited files were asked for, in the order they were asked. */
const askedFor = (calls: ReadonlyArray<{ method: string; path: string }>): string[] =>
  calls.filter((c) => c.path.endsWith('/changes')).map((c) => decodeURIComponent(c.path.split('/')[2]));

function withRoutes(extra: Record<string, ReturnType<typeof changes>>): CtxOptions['routes'] {
  return { ...ROUTES, ...extra };
}

describe('route: edited files', () => {
  it('reads a session’s edited files, and they decide between sessions that look alike', async () => {
    const a = worker(A, AGENT);
    const b = worker(B, AGENT);
    const routes = withRoutes({ [`GET /sessions/${B}/changes`]: changes('server/queue/flaky.test.ts') });

    const h = go({ sessions: [a, b], routes });
    const r = await h.result;

    expect(r.decision).toMatchObject({ kind: 'reuse', sessionId: B, score: 7 });
    expect(r.decision.reasons).toContain('task words match (3)');
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: A, score: 5 })]);
    expect(new Set(askedFor(h.client.calls))).toEqual(new Set([A, B]));
  });

  it('reads the files of the best eight candidates only', async () => {
    const sessions = Array.from({ length: 10 }, (_, i) => worker(`sess-w${String(i + 1).padStart(2, '0')}`, AGENT, { lastActivityAt: NOW - (200 + i) * MIN }));

    const h = go({ sessions });
    await h.result;

    // All score 5; the most recently active come first.
    expect(askedFor(h.client.calls).sort()).toEqual(sessions.slice(0, 8).map((s) => s.sessionId).sort());
  });

  it('does not read them for a session whose own text matched, or one that cannot be used', async () => {
    const matched = worker(A, AGENT, { title: 'flaky queue test' });
    const busy = worker(B, AGENT, { status: 'working' });
    const plain = worker(C, AGENT);

    const h = go({ sessions: [matched, busy, plain] });
    const r = await h.result;

    expect(askedFor(h.client.calls)).toEqual([C]);
    expect(reuseOf(r)).toBe(A);
  });

  it('does not read them when the task has no words to match, or when a new session was asked for', async () => {
    const sessions = [worker(A, AGENT), worker(B, AGENT)];

    const bland = go({ sessions }, { task: 'please fix it for me now', project: AGENT });
    await bland.result;
    expect(askedFor(bland.client.calls)).toEqual([]);

    const fresh = go({ sessions }, { newOnly: true });
    await fresh.result;
    expect(askedFor(fresh.client.calls)).toEqual([]);
  });

  it('a route that does not answer, or answers nonsense, is no files', async () => {
    const sessions = [worker(A, AGENT), worker(B, AGENT, withContext(10))];

    for (const answer of [fail(500, 'boom'), fail(404, 'Not found'), ok(null), ok({ files: 'nope' }), envelope({ files: [7, null, { path: 4 }] })]) {
      const routes = withRoutes({ [`GET /sessions/${A}/changes`]: answer, [`GET /sessions/${B}/changes`]: answer } as never);
      const r = await go({ sessions, routes }).result;
      expect(reuseOf(r)).toBe(B);
    }
  });

  it('an id that cannot be written into a route path is no files, not a failure', async () => {
    const odd = worker('..', AGENT, withContext(10));

    const r = await go({ sessions: [odd] }).result;

    expect(reuseOf(r)).toBe('..');
  });

  it('asks as the central: one GET per session, nothing else', async () => {
    const h = go({ sessions: [worker(A, AGENT)] });
    await h.result;

    const calls = h.client.calls.map((c) => `${c.method} ${c.path}`);
    expect(calls.filter((c) => c.endsWith('/changes'))).toEqual([`GET /sessions/${A}/changes`]);
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);
  });
});

describe('route: which sessions are candidates', () => {
  const project = (over: Parameters<typeof worker>[2], id = B) => worker(id, AGENT, over);

  it('a central, a popup, an external card, an SSH session and a session with no terminal or folder are not even listed', async () => {
    const others = [
      project({ central: { centralId: 'c9', kind: 'project', scopeRef: AGENT }, ...withContext(5), lastActivityAt: NOW }, 'sess-cen1'),
      project({ isFloating: true }, 'sess-flo1'),
      project({ isExternal: true }, 'sess-ext1'),
      project({ sshHost: 'build-box' }, 'sess-ssh1'),
      project({ terminalId: null }, 'sess-ter1'),
      makeSession('sess-fol1', { terminalId: 't', projectPath: '  ' }),
      project({ isSubagent: true }, 'sess-sub1'),
    ];
    const real = worker(A, AGENT);

    const r = await go({ sessions: [...others, real] }).result;

    expect(reuseOf(r)).toBe(A);
    expect(r.runnersUp).toEqual([]);
  });

  it('a session that has ended is not listed; one still starting is, as skipped', async () => {
    const ended = project({ status: 'ended', endedAt: NOW - MIN }, 'sess-end1');
    const starting = project({ status: 'connecting' }, 'sess-sta1');

    const r = await go({ sessions: [ended, starting] }).result;

    expect(r.decision.kind).toBe('create');
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: 'sess-sta1', skipped: 'connecting' })]);
  });

  it('a session in another folder is never listed, whatever it scores', async () => {
    const elsewhere = worker(A, SITE, { ...withContext(1), lastActivityAt: NOW, title: 'flaky queue test' });

    const r = await go({ sessions: [elsewhere] }).result;

    expect(r.decision.kind).toBe('create');
    expect(idsOf(r.runnersUp)).toEqual([]);
  });

  it('a global central’s own card is not a candidate even when idle and in the project', async () => {
    const own = makeSession('sess-own1', {
      projectPath: AGENT, terminalId: 'term-global', cliSource: 'claude', status: 'idle', lastActivityAt: NOW - MIN,
      central: { centralId: GLOBAL.centralId, kind: 'global', scopeRef: null },
    });

    const r = await go({ central: GLOBAL, sessions: [own] }, { task: 'tidy up the backlog', project: AGENT }).result;

    expect(r.decision.kind).toBe('create');
    expect(idsOf(r.runnersUp)).toEqual([]);
  });
});

describe('route: the explanation', () => {
  it('names the winner and a runner-up that scored but lost', async () => {
    const winner = worker(A, AGENT, { ...withContext(23), lastActivityAt: NOW - 10 * MIN });
    const second = worker(B, AGENT);

    const r = await go({ sessions: [winner, second] }).result;

    expect(explain(r)).toBe('routed to #sess-aaa: same folder, idle, ctx 23 %, active 10m ago; runner-up #sess-bbb scored 5');
  });
});
