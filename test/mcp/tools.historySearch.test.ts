// test/mcp/tools.historySearch.test.ts — the two history tools that search text (server/mcp/tools/historySearch.ts):
// history_search (full text over prompts and answers, `GET /db/search`) and history_prompts (the prompts a person
// typed, `GET /db/prompts`). Both are rate-limited by the server. The text is what sessions and people wrote: fenced
// as untrusted in `data` and in the text. Rulings 32 and 36 (see tools.history.test.ts) decide which rows a central sees.
import { describe, expect, it, vi } from 'vitest';
import {
  asGlobal,
  asProject,
  asRoom,
  endedIn,
  FOLDERS,
  liveOut,
  liveRemote,
  pagedSessions,
  rooms,
  row,
  serverProjects,
  serverPrompts,
  serverSessions,
  sessions,
} from './historyFixtures.js';
import { blocksIn, deepFreeze, everything, expectFenced, HOSTILE, outsideFences } from './readFixtures.js';
import { dataOf, fail, makeCentral, makeCtx, makeRoom, makeSession, ok, run, runRefused, type ApiCall } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

interface SearchData {
  type: string; page: number; pageSize: number; total: number | null; hasMore: boolean; count: number;
  results: Array<{ sessionId: string; projectName: string; type: string; text: string; textTruncated: boolean; timestamp: number }>;
}

const hit = (sessionId: string, over: Record<string, unknown> = {}) => ({
  session_id: sessionId, project_name: 'proj', type: 'prompt', text: `about ${sessionId}`, timestamp: 5_000, ...over,
});

describe('history_search', () => {
  const hits = [hit('s1'), hit('s2', { type: 'response', timestamp: 4_000 }), hit('s3', { timestamp: 3_000 })];
  const found = (rows: unknown[], total = rows.length) => ok({ results: rows, total, page: 1, pageSize: 20 });

  it('calls GET /db/search with the text, and with the kind, page and size only when they were asked for', async () => {
    const { ctx, client } = makeCtx({ routes: { 'GET /db/search': found(hits) } });

    await run('history_search', { query: 'login' }, ctx);
    await run('history_search', { query: 'login', type: 'responses', page: 3, pageSize: 10 }, ctx);

    expect(client.calls).toEqual([
      { method: 'GET', path: '/db/search', query: { query: 'login' } },
      { method: 'GET', path: '/db/search', query: { query: 'login', type: 'responses', page: 3, pageSize: 10 } },
    ]);
  });

  it('takes a text of sensible length and a page size the route would give, and refuses the rest', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/search': found(hits) } });

    await expect(run('history_search', {}, ctx)).rejects.toThrow(/query/);
    await expect(run('history_search', { query: '' }, ctx)).rejects.toThrow(/query/);
    await expect(run('history_search', { query: 'x'.repeat(201) }, ctx)).rejects.toThrow(/query/);
    await expect(run('history_search', { query: 'x', pageSize: 51 }, ctx)).rejects.toThrow(/pageSize/);
    await expect(run('history_search', { query: 'x', type: 'tools' }, ctx)).rejects.toThrow(/type/);
  });

  it('lists the hits: the session, its project, whether a prompt or an answer matched, when, and the text', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/search': found(hits, 45) } });

    const data = await dataOf<SearchData>('history_search', { query: 'login' }, ctx);

    expect(data).toMatchObject({ type: 'all', page: 1, pageSize: 20, total: 45, hasMore: true, count: 3 });
    expect(data.results.map((r) => [r.sessionId, r.projectName, r.type, r.timestamp])).toEqual([
      ['s1', 'proj', 'prompt', 5_000],
      ['s2', 'proj', 'response', 4_000],
      ['s3', 'proj', 'prompt', 3_000],
    ]);
    for (const r of data.results) expectFenced(r.text, r.type, `session:${r.sessionId}`);
    expect(data.results.map((r) => r.textTruncated)).toEqual([false, false, false]);
  });

  it('cuts a long excerpt at 500 characters in the data and the text', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/search': found([hit('s1', { text: 'e'.repeat(5_000) })]) } });

    const result = await run('history_search', { query: 'e' }, ctx);

    const [first] = (result.data as SearchData).results;
    expect(first.text.length).toBeLessThan(700);
    expect(first.textTruncated).toBe(true);
    expect(result.summary.length).toBeLessThan(1_500);
  });

  it('keeps hostile text inside its fence, and puts the rows in one block', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/search': found([hit('s1', { text: HOSTILE, project_name: HOSTILE })]) } });

    const result = await run('history_search', { query: 'x' }, ctx);

    expectFenced((result.data as SearchData).results[0].text, 'prompt');
    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('says so when nothing matches', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/search': found([]) } });

    const result = await run('history_search', { query: 'x' }, ctx);

    expect(result.data).toMatchObject({ count: 0, results: [], hasMore: false });
    expect(result.summary).toMatch(/Nothing in the history matches/);
  });

  it('turns the server’s rate limit into UNAVAILABLE with a hint to wait, and other failures into their codes', async () => {
    const limited = makeCtx({ routes: { 'GET /db/search': fail(429, 'Rate limit exceeded') } });
    const down = makeCtx({ routes: { 'GET /db/search': fail(500, 'boom') } });

    const err = await runRefused('history_search', { query: 'x' }, limited.ctx);

    expect(err.code).toBe('UNAVAILABLE');
    expect(err.hint).toMatch(/second/);
    expect((await runRefused('history_search', { query: 'x' }, down.ctx)).code).toBe('UPSTREAM');
  });

  describe('scope (Rulings 32 and 36): the route says only a session id and a project name, so the folder is looked up', () => {
    const scoped = [hit('s1'), hit('s2'), hit('s3'), hit('h-old'), hit('h-far'), hit('h-lost')];
    const history = [row('h-old', '/a/proj'), row('h-far', '/b/other')];
    const routesFor = (seen: Array<Record<string, unknown>> = []) => ({
      'GET /db/search': found(scoped),
      'GET /db/sessions': pagedSessions(history, seen),
    });
    const idsFor = async (central: ReturnType<typeof asGlobal>) => {
      const { ctx } = makeCtx({ central, sessions, rooms, routes: routesFor() });
      return (await dataOf<SearchData>('history_search', { query: 'x' }, ctx)).results.map((r) => r.sessionId);
    };

    it('shows a global central every hit, and asks nothing more', async () => {
      const { ctx, client } = makeCtx({ central: asGlobal(), sessions, rooms, routes: routesFor() });

      const data = await dataOf<SearchData>('history_search', { query: 'x' }, ctx);

      expect(data.results).toHaveLength(6);
      expect(client.calls.map((c) => c.path)).toEqual(['/db/search']);
    });

    it('shows a project central the hits of sessions inside its folder, found among the live sessions and the history', async () => {
      expect(await idsFor(asProject())).toEqual(['s1', 's2', 'h-old']);
    });

    it('shows a room central the hits of sessions in its sessions’ folders only', async () => {
      expect(await idsFor(asRoom())).toEqual(['s1', 's2', 'h-old']);
    });

    it('drops a hit whose session it cannot place, and never says how many it dropped or how many there are in all', async () => {
      const { ctx } = makeCtx({ central: asProject(), sessions, rooms, routes: routesFor() });

      const result = await run('history_search', { query: 'x' }, ctx);
      const data = result.data as SearchData;

      expect(data.total).toBeNull();
      expect(everything(result)).not.toMatch(/h-far|h-lost|s3|b\/other/);
    });

    it('looks sessions up in the history only for hits no live session answers for, 200 rows a page', async () => {
      const seen: Array<Record<string, unknown>> = [];
      const live = [hit('s1'), hit('s2')];
      const onlyLive = makeCtx({ central: asProject(), sessions, rooms, routes: { 'GET /db/search': found(live), 'GET /db/sessions': pagedSessions(history, seen) } });
      const some = makeCtx({ central: asProject(), sessions, rooms, routes: routesFor(seen) });

      await run('history_search', { query: 'x' }, onlyLive.ctx);
      expect(onlyLive.client.calls.map((c) => c.path)).toEqual(['/db/search']);

      await run('history_search', { query: 'x' }, some.ctx);
      expect(seen).toEqual([{ page: 1, pageSize: 200, archived: 'all' }]);
    });

    it('looks for archived sessions too: a hit in one of the central’s own archived sessions is kept', async () => {
      const seen: Array<Record<string, unknown>> = [];
      const archived = [row('h-arch', '/a/proj', { archived: 1 })];
      const { ctx } = makeCtx({
        central: asProject(), sessions, rooms,
        routes: { 'GET /db/search': found([hit('h-arch')]), 'GET /db/sessions': serverSessions(archived, seen) },
      });

      const data = await dataOf<SearchData>('history_search', { query: 'x' }, ctx);

      expect(data.results.map((r) => r.sessionId)).toEqual(['h-arch']);
      expect(seen).toEqual([{ page: 1, pageSize: 200, archived: 'all' }]);
    });

    describe('Ruling 36: a hit of a live session follows session scope', () => {
      // s1 is live in room r1; live-out is live in /a/proj but in no room; ended-in has ended in /a/proj; gone is only in the history.
      const store = [...sessions, liveOut, endedIn];
      const mixed = [hit('s1'), hit('live-out'), hit('ended-in'), hit('gone')];
      const history = [row('gone', '/a/proj')];
      const idsFor = async (central: ReturnType<typeof asGlobal>, held = store) => {
        const { ctx } = makeCtx({ central, sessions: held, rooms, routes: { 'GET /db/search': found(mixed), 'GET /db/sessions': serverSessions(history) } });
        return (await dataOf<SearchData>('history_search', { query: 'x' }, ctx)).results.map((r) => r.sessionId);
      };

      it('keeps the hits of a live session outside a room central’s room out, though its folder is one of the room’s', async () => {
        expect(await idsFor(asRoom())).toEqual(['s1', 'ended-in', 'gone']);
      });

      it('still shows a room central the hits of an ended session in a folder of its room, and of one only the history knows', async () => {
        const ids = await idsFor(asRoom());

        expect(ids).toContain('ended-in');
        expect(ids).toContain('gone');
        expect(ids).not.toContain('live-out');
      });

      it('keeps the hits of a live session on another machine out of a project central’s results', async () => {
        const remote = [hit('s2'), hit('live-remote')];
        const { ctx } = makeCtx({ central: asProject(), sessions: [...sessions, liveRemote], rooms, routes: { 'GET /db/search': found(remote) } });

        expect((await dataOf<SearchData>('history_search', { query: 'x' }, ctx)).results.map((r) => r.sessionId)).toEqual(['s2']);
      });

      it('shows a global central every hit', async () => {
        expect(await idsFor(asGlobal())).toEqual(['s1', 'live-out', 'ended-in', 'gone']);
      });

      it('needs no folder for a live session that is in scope: it asks the history nothing about it', async () => {
        const bare = makeSession('s-bare', { projectPath: '' });
        const { ctx, client } = makeCtx({
          central: makeCentral('room', 'r-bare'), sessions: [bare], rooms: [makeRoom('r-bare', ['s-bare'])],
          routes: { 'GET /db/search': found([hit('s-bare')]), 'GET /db/sessions': serverSessions([]) },
        });

        const data = await dataOf<SearchData>('history_search', { query: 'x' }, ctx);

        expect(data.results.map((r) => r.sessionId)).toEqual(['s-bare']);
        expect(client.calls.map((c) => c.path)).toEqual(['/db/search']);
      });
    });

    it('looks through at most 5 pages of the history for a hit’s session, and drops the hit when it is not there', async () => {
      const seen: Array<Record<string, unknown>> = [];
      const filler = Array.from({ length: 1_400 }, (_, i) => row(`f${i}`, '/b/other'));
      const far = [...filler, row('h-late', '/a/proj')];
      const { ctx } = makeCtx({ central: asProject(), sessions, rooms, routes: { 'GET /db/search': found([hit('h-late')]), 'GET /db/sessions': pagedSessions(far, seen) } });

      const data = await dataOf<SearchData>('history_search', { query: 'x' }, ctx);

      expect(seen.map((q) => q.page)).toEqual([1, 2, 3, 4, 5]);
      expect(data.results).toEqual([]);
    });

    it('says a page may be followed by more when the route’s page was full, without saying how many hits were cut', async () => {
      const full = Array.from({ length: 20 }, (_, i) => hit(i === 0 ? 's1' : `h-far`));
      const { ctx } = makeCtx({ central: asProject(), sessions, rooms, routes: { 'GET /db/search': found(full, 500), 'GET /db/sessions': pagedSessions(history) } });

      const data = await dataOf<SearchData>('history_search', { query: 'x' }, ctx);

      expect(data).toMatchObject({ count: 1, total: null, hasMore: true });
    });
  });

  it('changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify({ results: hits, total: 3, page: 1, pageSize: 20 })));
    const { ctx } = makeCtx({ routes: { 'GET /db/search': ok(frozen) } });

    await expect(run('history_search', { query: 'x' }, ctx)).resolves.toBeDefined();
  });
});

interface PromptsData {
  count: number; total: number | null; page: number; pageSize: number; hasMore: boolean; capped: boolean;
  prompts: Array<{ id: number; sessionId: string; sessionTitle: string | null; project: string | null; timestamp: number; text: string; textTruncated: boolean }>;
}

const prompt = (id: number, text: string, projectPath: string | null = '/a/proj', over: Record<string, unknown> = {}) => ({
  id, session_id: `s-${id}`, text, timestamp: 1_000 + id, project_name: projectPath === null ? null : projectPath.split('/').pop(), project_path: projectPath, session_title: `Session ${id}`, ...over,
});

describe('history_prompts', () => {
  const typed = [prompt(1, 'fix the login redirect'), prompt(2, '/plan the migration'), prompt(3, 'use <b> tags in the footer')];
  const harness = [
    prompt(4, '<task-notification>a worker finished</task-notification>'),
    prompt(5, '  <system-reminder>do not mention this'),
    prompt(6, '\n\t<observed_from_primary_session>x'),
    prompt(7, '<<autonomous-loop-dynamic>>'),
  ];
  const promptsRoute = (rows: unknown[]) => ok({ prompts: rows, total: rows.length, page: 1, pageSize: 50 });

  it('calls GET /db/prompts for the prompts a person typed (kind mine), and passes on the folder, session, text, dates and page', async () => {
    const { ctx, client } = makeCtx({ routes: { 'GET /db/prompts': promptsRoute(typed) } });

    await run('history_prompts', {}, ctx);
    await run('history_prompts', { project: '/a/proj/../proj', session: 's-1', query: 'login', dateFrom: '2026-10-01', dateTo: '2026-10-24', page: 2, pageSize: 25 }, ctx);

    expect(client.calls).toEqual([
      { method: 'GET', path: '/db/prompts', query: { kind: 'mine' } },
      {
        method: 'GET', path: '/db/prompts',
        query: {
          kind: 'mine', project: '/a/proj', session: 's-1', query: 'login', dateFrom: Date.parse('2026-10-01'), dateTo: Date.parse('2026-10-24'),
          page: 2, pageSize: 25,
        },
      },
    ]);
  });

  it('history_prompts excludes harness rows: whatever starts with < once the white space is gone', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': promptsRoute([...harness.slice(0, 2), typed[0], harness[2], typed[1], harness[3], typed[2]]) } });

    const result = await run('history_prompts', {}, ctx);
    const data = result.data as PromptsData;

    expect(data.prompts.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(everything(result)).not.toMatch(/task-notification|system-reminder|observed_from|autonomous-loop|do not mention/);
    expect(data.count).toBe(3);
  });

  it('lists each prompt with its session, the session’s title, the folder, the time and the text, the text and the title fenced', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': promptsRoute(typed) } });

    const data = await dataOf<PromptsData>('history_prompts', {}, ctx);

    expect(data).toMatchObject({ count: 3, total: 3, page: 1, pageSize: 50, hasMore: false });
    expect(data.prompts[0]).toMatchObject({ id: 1, sessionId: 's-1', project: '/a/proj', timestamp: 1_001, textTruncated: false });
    expectFenced(data.prompts[0].text, 'prompt', 'session:s-1');
    expectFenced(data.prompts[0].sessionTitle, 'title', 'session:s-1');
    expect(data.prompts[0].text).toContain('fix the login redirect');
  });

  it('keeps a prompt whose session row is gone (no folder, no title) for a global central', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': promptsRoute([prompt(1, 'orphan', null, { session_title: null })]) } });

    const data = await dataOf<PromptsData>('history_prompts', {}, ctx);

    expect(data.prompts[0]).toMatchObject({ project: null, sessionTitle: null });
  });

  it('cuts a long prompt at 1 500 characters and says it was cut', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': promptsRoute([prompt(1, 'q'.repeat(9_000))]) } });

    const result = await run('history_prompts', {}, ctx);
    const first = (result.data as PromptsData).prompts[0];

    expect(first.textTruncated).toBe(true);
    expect(first.text.length).toBeLessThan(1_700);
    expect(result.summary.length).toBeLessThan(2_500);
  });

  it('keeps hostile text inside fences, and puts the rows in one block', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': promptsRoute([prompt(1, HOSTILE, '/a/proj', { session_title: HOSTILE })]) } });

    const result = await run('history_prompts', {}, ctx);

    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('says so when the person typed nothing there', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': promptsRoute([...harness]) } });

    expect((await run('history_prompts', {}, ctx)).summary).toMatch(/No typed prompts/);
  });

  it('turns the server’s rate limit into UNAVAILABLE with a hint to wait', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': fail(429, 'Rate limit exceeded') } });

    const err = await runRefused('history_prompts', {}, ctx);

    expect(err.code).toBe('UNAVAILABLE');
    expect(err.hint).toMatch(/second/);
  });

  it('says there is another page when the route has one, by number, and says a page is past the end', async () => {
    const many = Array.from({ length: 60 }, (_, i) => prompt(i + 1, `p${i}`));
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': serverPrompts(many) } });

    const first = await run('history_prompts', {}, ctx);
    const last = await run('history_prompts', { page: 2 }, ctx);
    const past = await run('history_prompts', { page: 3 }, ctx);

    expect(first.data).toMatchObject({ count: 50, total: 60, hasMore: true, capped: false });
    expect(first.summary).toContain('There is more: ask for page 2.');
    expect(last.summary).not.toMatch(/ask for page|stopped/);
    expect(past.summary).toMatch(/Page 3 is past the end/);
  });

  describe('scope (Rulings 32 and 36)', () => {
    // Newest first by their number: p10 /a/proj, p11 /a/proj/sub, p12 /a/proj/deeper/x, p13 /a/other, p14 /a/project2, p15 /b/other, p16 no session row.
    const rows = FOLDERS.map((folder, i) => prompt(i + 10, `prompt in ${folder || 'nowhere'}`, folder === '' ? null : folder, { timestamp: 1_000 - i }));
    interface World {
      central?: ReturnType<typeof makeCentral>;
      rows?: unknown[];
      store?: ReturnType<typeof makeSession>[];
      rooms?: ReturnType<typeof makeRoom>[];
      route?: (rows: unknown[], seen: Array<Record<string, unknown>>) => (call: ApiCall) => ReturnType<typeof ok>;
    }
    const worldOf = (w: World = {}) => {
      const seen: Array<Record<string, unknown>> = [];
      const rowsOf = w.rows ?? rows;
      const made = makeCtx({
        central: w.central ?? asGlobal(),
        sessions: w.store ?? sessions,
        rooms: w.rooms ?? rooms,
        routes: { 'GET /db/prompts': (w.route ?? serverPrompts)(rowsOf, seen), 'GET /db/projects': serverProjects(rowsOf) },
      });
      return { ...made, seen };
    };
    const projectsOf = async (central: ReturnType<typeof makeCentral>) =>
      (await dataOf<PromptsData>('history_prompts', {}, worldOf({ central }).ctx)).prompts.map((p) => p.project);
    const idsOf = async (w: World, args: Record<string, unknown> = {}) =>
      (await dataOf<PromptsData>('history_prompts', args, worldOf(w).ctx)).prompts.map((p) => p.id);

    it('shows a global central every prompt, even one with no session row, and asks the route once, not for the folders', async () => {
      const w = worldOf({ central: asGlobal() });

      const data = await dataOf<PromptsData>('history_prompts', {}, w.ctx);

      expect(data.prompts.map((p) => p.project)).toEqual(FOLDERS.map((f) => (f === '' ? null : f)));
      expect(w.client.calls.map((c) => c.path)).toEqual(['/db/prompts']);
    });

    it('shows a project central only prompts sent inside its folder', async () => {
      expect(await projectsOf(asProject())).toEqual(['/a/proj', '/a/proj/sub', '/a/proj/deeper/x']);
    });

    it('shows a room central only prompts sent in its sessions’ folders', async () => {
      expect(await projectsOf(asRoom())).toEqual(['/a/proj', '/a/proj/sub']);
    });

    it('asks the route about the folders the central may see and no other, each exactly, 200 rows a page', async () => {
      const w = worldOf({ central: asProject() });

      const data = await dataOf<PromptsData>('history_prompts', {}, w.ctx);

      expect(w.client.calls.map((c) => c.path)).toEqual(['/db/projects', '/db/prompts', '/db/prompts', '/db/prompts']);
      expect(w.seen.map((q) => q.project).sort()).toEqual(['/a/proj', '/a/proj/deeper/x', '/a/proj/sub']);
      for (const query of w.seen) expect(query).toMatchObject({ kind: 'mine', page: 1, pageSize: 200 });
      expect(data.total).toBeNull();
    });

    it('drops the harness’s turns the route let through, before it counts them', async () => {
      const mixed = [...harness.map((h) => ({ ...h, project_path: '/a/proj' })), ...typed];
      const lax = (all: unknown[], seen: Array<Record<string, unknown>>) => (call: ApiCall) => serverPrompts(all, seen)({ ...call, query: { ...call.query, kind: 'all' } });

      const data = await dataOf<PromptsData>('history_prompts', {}, worldOf({ central: asProject(), rows: mixed, route: lax }).ctx);

      expect(data.prompts.map((p) => p.id)).toEqual([3, 2, 1]);
      expect(data.count).toBe(3);
    });

    it('merges what the folders hold, newest first, and pages through the merge', async () => {
      const mix = [
        prompt(1, 'p1', '/a/proj', { timestamp: 100 }), prompt(2, 'u1', '/a/proj/sub', { timestamp: 90 }), prompt(3, 'p2', '/a/proj', { timestamp: 80 }),
        prompt(4, 'u2', '/a/proj/sub', { timestamp: 70 }), prompt(5, 'p3', '/a/proj', { timestamp: 60 }), prompt(6, 'o1', '/b/other', { timestamp: 95 }),
      ];
      const page = async (n: number) => await dataOf<PromptsData>('history_prompts', { page: n, pageSize: 2 }, worldOf({ central: asProject(), rows: mix }).ctx);

      const [first, second, third] = [await page(1), await page(2), await page(3)];

      expect(first.prompts.map((p) => p.id)).toEqual([1, 2]);
      expect(second.prompts.map((p) => p.id)).toEqual([3, 4]);
      expect(third.prompts.map((p) => p.id)).toEqual([5]);
      expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    });

    it('breaks a tie between the folders’ prompts by id, the larger id first, as the route does inside one folder', async () => {
      const tie = [prompt(1, 'a', '/a/proj', { timestamp: 50 }), prompt(2, 'b', '/a/proj/sub', { timestamp: 50 }), prompt(3, 'c', '/a/proj', { timestamp: 50 })];

      expect(await idsOf({ central: asProject(), rows: tie })).toEqual([3, 2, 1]);
    });

    it('finds a folder’s prompts under any amount of newer prompts in other folders', async () => {
      const buried = [
        ...Array.from({ length: 2_000 }, (_, i) => prompt(1_000 + i, `x${i}`, '/b/other', { timestamp: 100_000 - i })),
        prompt(1, 'mine', '/a/proj', { timestamp: 5 }),
      ];
      const w = worldOf({ central: asProject(), rows: buried });

      const result = await run('history_prompts', {}, w.ctx);

      expect((result.data as PromptsData).prompts.map((p) => p.id)).toEqual([1]);
      expect(result.data).toMatchObject({ hasMore: false, capped: false });
      expect(w.seen).toHaveLength(1);
    });

    describe('when its read reaches its limit (8 route pages) before the end', () => {
      const hidden = Array.from({ length: 2_000 }, (_, i) => prompt(1_000 + i, `x${i}`, '/b/other', { timestamp: 100_000 - i }));
      // Seven folders inside the project: more than it asks the route about one by one, so it reads every prompt whole.
      const seven = Array.from({ length: 7 }, (_, i) => prompt(500 + i, `m${i}`, `/a/proj/m${i}`, { timestamp: 50 + i }));

      it('says how far it looked, that older prompts may match and which filters reach them, instead of saying nothing matches', async () => {
        const w = worldOf({ central: asProject(), rows: [...hidden, ...seven] });

        const result = await run('history_prompts', {}, w.ctx);

        expect(w.seen).toHaveLength(8);
        expect(result.data).toMatchObject({ count: 0, total: null, hasMore: true, capped: true });
        expect(result.summary).toMatch(/It read 1600 prompts/);
        expect(result.summary).toMatch(/Older ones may match/);
        expect(result.summary).toMatch(/narrow it with project \(one folder\), session, dateFrom and dateTo, or query/);
        expect(result.summary).not.toMatch(/No typed prompts match/);
        expect(result.summary).not.toMatch(/ask for page/);
      });

      it('lets the filters it points to reach what it could not: dates older than what it read find the rest', async () => {
        const w = worldOf({ central: asProject(), rows: [...hidden, ...seven] });

        const result = await run('history_prompts', { dateTo: '1970-01-01T00:00:00.100Z' }, w.ctx);

        expect((result.data as PromptsData).prompts).toHaveLength(7);
        expect(result.data).toMatchObject({ hasMore: false, capped: false });
      });

      it('says where it stopped when it has some prompts for the page but cannot fill it, and does not offer another page', async () => {
        const many = Array.from({ length: 1_700 }, (_, i) => prompt(1_000 + i, `d${i}`, '/a/proj', { timestamp: 100_000 - i }));
        const w = worldOf({ central: asProject(), rows: many });

        const result = await run('history_prompts', { page: 16, pageSize: 100 }, w.ctx);

        expect((result.data as PromptsData).count).toBe(100);
        expect(result.data).toMatchObject({ hasMore: true, capped: true });
        expect(result.summary).toMatch(/stopped after reading 1600 prompts/);
        expect(result.summary).not.toMatch(/ask for page/);
      });
    });

    it('passes a folder inside the scope on to the route, exactly, and refuses one that is not without calling it', async () => {
      const w = worldOf({ central: asProject() });

      await run('history_prompts', { project: '/a/proj/sub' }, w.ctx);
      const refused = await runRefused('history_prompts', { project: '/b/other' }, w.ctx);

      expect(w.seen).toEqual([{ kind: 'mine', project: '/a/proj/sub', page: 1, pageSize: 200 }]);
      expect(w.client.calls.map((c) => c.path)).toEqual(['/db/prompts']);
      expect(refused.code).toBe('NOT_IN_SCOPE');
      expect(`${refused.message} ${refused.hint}`).not.toContain('/b/other');
    });

    it('asks a global central’s folder through the route’s own filter and page', async () => {
      const w = worldOf({ central: asGlobal() });

      const data = await dataOf<PromptsData>('history_prompts', { project: '/b/other' }, w.ctx);

      expect(w.seen).toEqual([{ kind: 'mine', project: '/b/other' }]);
      expect(data.prompts.map((p) => p.project)).toEqual(['/b/other']);
    });

    it('asks about one session by the route’s own session filter, in one read, with no folder questions', async () => {
      const w = worldOf({ central: asProject() });

      await run('history_prompts', { session: 's-10' }, w.ctx);

      expect(w.client.calls.map((c) => c.path)).toEqual(['/db/prompts']);
      expect(w.seen).toEqual([{ kind: 'mine', session: 's-10', page: 1, pageSize: 200 }]);
    });

    describe('Ruling 36: a prompt of a live session follows session scope', () => {
      // s1 is live in room r1; live-out is live in /a/proj but in no room; ended-in has ended in /a/proj; gone is only in the history.
      const store = [...sessions, liveOut, endedIn];
      const same = [
        prompt(1, 'from s1', '/a/proj', { session_id: 's1', timestamp: 40 }),
        prompt(2, 'from live-out', '/a/proj', { session_id: 'live-out', timestamp: 30 }),
        prompt(3, 'from ended-in', '/a/proj', { session_id: 'ended-in', timestamp: 20 }),
        prompt(4, 'from gone', '/a/proj', { session_id: 'gone', timestamp: 10 }),
      ];

      it('keeps the prompts of a live session outside a room central’s room out, though its folder is one of the room’s', async () => {
        expect(await idsOf({ central: asRoom(), store, rows: same })).toEqual([1, 3, 4]);
      });

      it('still shows a room central the prompts of an ended session in a folder of its room, and of one only the history knows', async () => {
        const ids = await idsOf({ central: asRoom(), store, rows: same });

        expect(ids).toContain(3);
        expect(ids).toContain(4);
        expect(ids).not.toContain(2);
      });

      it('gives nothing for a live session outside the room even when it is named, and says nothing of it', async () => {
        const result = await run('history_prompts', { session: 'live-out' }, worldOf({ central: asRoom(), store, rows: same }).ctx);

        expect(result.data).toMatchObject({ count: 0, hasMore: false });
        expect(result.summary).toBe('No typed prompts match.');
      });

      it('keeps the prompts of a live session on another machine out of a project central’s results', async () => {
        const remote = [
          prompt(1, 'from s2', '/a/proj/sub', { session_id: 's2', timestamp: 30 }),
          prompt(2, 'from live-remote', '/a/proj/sub', { session_id: 'live-remote', timestamp: 20 }),
        ];

        expect(await idsOf({ central: asProject(), store: [...sessions, liveRemote], rows: remote })).toEqual([1]);
      });

      it('shows a global central every one of them', async () => {
        expect(await idsOf({ central: asGlobal(), store, rows: same })).toEqual([1, 2, 3, 4]);
      });

      it('shows a live session in scope that has no folder in the history, and reads every prompt to find it', async () => {
        const bare = makeSession('s-bare', { projectPath: '' });
        const history = [
          prompt(1, 'from bare', null, { session_id: 's-bare', timestamp: 30 }),
          prompt(2, 'elsewhere', '/a/proj', { session_id: 'someone', timestamp: 20 }),
        ];
        const w = worldOf({ central: makeCentral('room', 'r-bare'), store: [bare], rooms: [makeRoom('r-bare', ['s-bare'])], rows: history });

        const data = await dataOf<PromptsData>('history_prompts', {}, w.ctx);

        expect(data.prompts.map((p) => p.id)).toEqual([1]);
        expect(w.seen.map((q) => q.project)).toEqual([undefined]);
      });
    });
  });

  it('changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify({ prompts: typed, total: 3, page: 1, pageSize: 50 })));
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': ok(frozen) } });

    await expect(run('history_prompts', {}, ctx)).resolves.toBeDefined();
  });
});
