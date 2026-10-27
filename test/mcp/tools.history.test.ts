// test/mcp/tools.history.test.ts — the history toolset's P1 reads that list and describe ended sessions
// (server/mcp/tools/history.ts): history_list, history_get, history_projects and history_known_projects. (The two
// that search text, history_search and history_prompts, are in tools.historySearch.test.ts.)
//
// Ruling 32, history scope: a global central sees all of it; a PROJECT central only rows whose folder is inside its
// scope folder; a ROOM central only rows whose folder is one of the folders of its in-scope sessions. A row whose
// folder is not known is not shown to a central that is scoped.
// Ruling 36: a row of a session that is still LIVE follows session scope instead (in scope: seen; out of scope: not,
// even in a folder the folder rule allows); the folder rule is for sessions that have ended.
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
  serverSessions,
  sessions,
} from './historyFixtures.js';
import { blocksIn, deepFreeze, everything, expectFenced, HOSTILE, outsideFences } from './readFixtures.js';
import { dataOf, fail, makeCentral, makeCtx, makeRoom, makeSession, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

interface HistoryRowData {
  id: string; title: string; summary: string | null; remark: string | null; project: { path: string; name: string };
  status: string; source: string; model: string; startedAt: number | null; endedAt: number | null; lastActivityAt: number | null;
  prompts: number; toolCalls: number; archived: boolean;
}
interface HistoryListData {
  count: number; total: number | null; page: number; pageSize: number; hasMore: boolean; capped: boolean; sessions: HistoryRowData[];
}

describe('history_list', () => {
  const rows = [row('h1', '/a/proj'), row('h2', '/a/proj/sub', { status: 'working', archived: 1 })];

  it('calls GET /db/sessions asking for archived sessions too, and for nothing else but what was asked for', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { ctx, client } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(rows, seen) } });

    await run('history_list', {}, ctx);
    await run('history_list', { project: '/a/proj/../proj', query: 'login', status: 'ended', dateFrom: '2026-10-01', dateTo: '2026-10-24T12:00:00Z', page: 2, pageSize: 10 }, ctx);

    expect(client.calls).toEqual([
      { method: 'GET', path: '/db/sessions', query: { archived: 'all' } },
      {
        method: 'GET', path: '/db/sessions',
        query: {
          query: 'login', project: '/a/proj', status: 'ended', dateFrom: Date.parse('2026-10-01'), dateTo: Date.parse('2026-10-24T12:00:00Z'),
          archived: 'all', page: 2, pageSize: 10,
        },
      },
    ]);
  });

  it('lists archived sessions too: the route leaves them out unless the call says archived=all', async () => {
    const mixed = [row('h1', '/a/proj', { started_at: 2_000 }), row('h2', '/a/proj', { started_at: 1_000, archived: 1 })];
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': serverSessions(mixed) } });

    const data = await dataOf<HistoryListData>('history_list', {}, ctx);

    expect(data.sessions.map((s) => [s.id, s.archived])).toEqual([['h1', false], ['h2', true]]);
    expect(data.total).toBe(2);
  });

  it('lists each session: its title, folder, status, times, counts and whether it is archived', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(rows) } });

    const data = await dataOf<HistoryListData>('history_list', {}, ctx);

    expect(data).toMatchObject({ count: 2, total: 2, page: 1, pageSize: 50, hasMore: false, capped: false });
    expect(data.sessions[0]).toMatchObject({
      id: 'h1', project: { path: '/a/proj', name: 'proj' }, status: 'ended', source: 'ssh', model: 'opus',
      startedAt: 1_000, endedAt: 2_000, lastActivityAt: 1_500, prompts: 3, toolCalls: 7, archived: false,
    });
    expect(data.sessions[1]).toMatchObject({ id: 'h2', status: 'working', archived: true });
  });

  it('fences the title, the summary and the remark of each session in the data', async () => {
    const full = [row('h1', '/a/proj', { summary: 'It fixed the login.', remark: 'Check later' })];
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(full) } });

    const { sessions: listed } = await dataOf<HistoryListData>('history_list', {}, ctx);

    expectFenced(listed[0].title, 'title', 'session:h1');
    expectFenced(listed[0].summary, 'summary', 'session:h1');
    expectFenced(listed[0].remark, 'remark', 'session:h1');
    const bare = await dataOf<HistoryListData>('history_list', {}, makeCtx({ routes: { 'GET /db/sessions': pagedSessions(rows) } }).ctx);
    expect(bare.sessions[0].summary).toBeNull();
    expect(bare.sessions[0].remark).toBeNull();
  });

  it('says there is another page when the route has one, and asks for it by number', async () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`h${i}`, '/a/proj'));
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(many) } });

    const first = await run('history_list', {}, ctx);
    const last = await run('history_list', { page: 2 }, ctx);

    expect(first.data).toMatchObject({ count: 50, total: 60, hasMore: true, capped: false });
    expect(first.summary).toContain('There is more: ask for page 2.');
    expect(last.data).toMatchObject({ count: 10, page: 2, hasMore: false });
    expect(last.summary).not.toMatch(/ask for page|stopped/);
  });

  it('does not offer a page after the last when the rows fill their page exactly', async () => {
    const exact = Array.from({ length: 50 }, (_, i) => row(`h${i}`, '/a/proj'));
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(exact) } });

    const result = await run('history_list', {}, ctx);

    expect(result.data).toMatchObject({ count: 50, total: 50, hasMore: false, capped: false });
    expect(result.summary).not.toMatch(/ask for page|stopped/);
  });

  it('refuses a date it cannot read, and a page size the route would not give, without repeating them', async () => {
    const { ctx, client } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(rows) } });
    const needle = 'NEEDLE-NOT-A-DATE';

    const err = await runRefused('history_list', { dateFrom: needle }, ctx);

    expect(err.code).toBe('INVALID');
    expect(`${err.message} ${err.hint}`).not.toContain(needle);
    expect(client.calls).toEqual([]);
    await expect(run('history_list', { pageSize: 201 }, ctx)).rejects.toThrow(/pageSize/);
  });

  it('reads the ISO dates and times an agent writes, and refuses everything else, even text V8’s Date.parse would guess at', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(rows) } });

    for (const good of ['2026-10-01', '2026-10-24T12:00', '2026-10-24T12:00:00Z', '2026-10-24T12:00:00.5+13:00', '2026-10-24 12:00']) {
      await expect(run('history_list', { dateFrom: good }, ctx), good).resolves.toBeDefined();
    }
    for (const bad of ['yesterday', 'Oct 24 2026', '24/10/2026', 'UNIQUE-NEEDLE 2026', '2026-13-45', '2026-10-24T25:61']) {
      expect((await runRefused('history_list', { dateTo: bad }, ctx)).code, bad).toBe('INVALID');
    }
  });

  it('says so when the history is empty, and when a page is past the end of it', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions([]) } });
    const some = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(rows) } });

    expect((await run('history_list', {}, ctx)).summary).toMatch(/No sessions in the history/);
    const past = await run('history_list', { page: 3 }, some.ctx);
    expect(past.summary).toMatch(/Page 3 is past the end/);
    expect(past.summary).not.toMatch(/No sessions in the history/);
  });

  it('keeps hostile text inside fences: the rows are one block in the text', async () => {
    const evil = [row('h1', '/a/proj', { title: HOSTILE, summary: HOSTILE, remark: HOSTILE })];
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': pagedSessions(evil) } });

    const result = await run('history_list', {}, ctx);

    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  describe('scope (Rulings 32 and 36)', () => {
    // Newest first by their number: h0 /a/proj, h1 /a/proj/sub, h2 /a/proj/deeper/x, h3 /a/other, h4 /a/project2, h5 /b/other, h6 no folder.
    const all = FOLDERS.map((folder, i) => row(`h${i}`, folder, { started_at: 1_000 - i }));
    interface World {
      central?: ReturnType<typeof makeCentral>;
      rows?: unknown[];
      store?: ReturnType<typeof makeSession>[];
      rooms?: ReturnType<typeof makeRoom>[];
    }
    const worldOf = (w: World = {}) => {
      const seen: Array<Record<string, unknown>> = [];
      const folders: Array<Record<string, unknown>> = [];
      const rowsOf = w.rows ?? all;
      const made = makeCtx({
        central: w.central ?? asGlobal(),
        sessions: w.store ?? sessions,
        rooms: w.rooms ?? rooms,
        routes: { 'GET /db/sessions': serverSessions(rowsOf, seen), 'GET /db/projects': serverProjects(rowsOf, folders) },
      });
      return { ...made, seen, folders };
    };
    const idsOf = async (w: World, args: Record<string, unknown> = {}) =>
      (await dataOf<HistoryListData>('history_list', args, worldOf(w).ctx)).sessions.map((x) => x.id);
    const pathsOf = async (central: ReturnType<typeof makeCentral>) =>
      (await dataOf<HistoryListData>('history_list', {}, worldOf({ central }).ctx)).sessions.map((x) => x.project.path);

    it('shows a global central every row, and asks the route once, for the page, not for the folders', async () => {
      const w = worldOf({ central: asGlobal() });

      const data = await dataOf<HistoryListData>('history_list', {}, w.ctx);

      expect(data.sessions.map((x) => x.project.path)).toEqual(FOLDERS);
      expect(w.client.calls.map((c) => c.path)).toEqual(['/db/sessions']);
    });

    it('shows a project central only rows whose folder is its folder or inside it', async () => {
      expect(await pathsOf(asProject())).toEqual(['/a/proj', '/a/proj/sub', '/a/proj/deeper/x']);
    });

    it('shows a room central only rows whose folder is one of its sessions’ folders', async () => {
      expect(await pathsOf(asRoom())).toEqual(['/a/proj', '/a/proj/sub']);
    });

    it('shows a central with no scope to speak of nothing (an unknown kind, a room nobody is in)', async () => {
      expect(await pathsOf(makeCentral('room', 'nobody'))).toEqual([]);
      expect(await pathsOf({ ...makeCentral('global'), kind: 'galaxy' } as never)).toEqual([]);
    });

    it('asks the route about the folders the central may see and no other, each exactly, and learns them from the history’s own folders', async () => {
      const w = worldOf({ central: asProject() });

      await run('history_list', {}, w.ctx);

      expect(w.client.calls.map((c) => c.path)).toEqual(['/db/projects', '/db/sessions', '/db/sessions', '/db/sessions']);
      expect(w.seen.map((q) => q.project).sort()).toEqual(['/a/proj', '/a/proj/deeper/x', '/a/proj/sub']);
      for (const query of w.seen) expect(query).toMatchObject({ archived: 'all', page: 1, pageSize: 200 });
    });

    it('asks for no row at all when no folder of the history is one it may see', async () => {
      const w = worldOf({ central: makeCentral('room', 'nobody') });

      const data = await dataOf<HistoryListData>('history_list', {}, w.ctx);

      expect(w.client.calls.map((c) => c.path)).toEqual(['/db/projects']);
      expect(data).toMatchObject({ count: 0, hasMore: false, capped: false });
    });

    it('does not say how many rows there are in all to a central that is scoped, since that would count what it cannot see', async () => {
      const data = await dataOf<HistoryListData>('history_list', {}, worldOf({ central: asProject() }).ctx);

      expect(data.total).toBeNull();
      expect(data.count).toBe(3);
    });

    it('merges what the folders hold, newest first, and pages through the merge', async () => {
      const mix = [
        row('p1', '/a/proj', { started_at: 100 }), row('u1', '/a/proj/sub', { started_at: 90 }), row('p2', '/a/proj', { started_at: 80 }),
        row('u2', '/a/proj/sub', { started_at: 70 }), row('p3', '/a/proj', { started_at: 60 }), row('o1', '/b/other', { started_at: 95 }),
      ];
      const page = async (n: number) => await dataOf<HistoryListData>('history_list', { page: n, pageSize: 2 }, worldOf({ central: asProject(), rows: mix }).ctx);

      const [first, second, third] = [await page(1), await page(2), await page(3)];

      expect(first.sessions.map((x) => x.id)).toEqual(['p1', 'u1']);
      expect(second.sessions.map((x) => x.id)).toEqual(['p2', 'u2']);
      expect(third.sessions.map((x) => x.id)).toEqual(['p3']);
      expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    });

    it('asks about a folder once even when the history lists it under two names', async () => {
      const renamed = [row('n1', '/a/proj', { started_at: 20, project_name: 'old name' }), row('n2', '/a/proj', { started_at: 10, project_name: 'new name' })];
      const w = worldOf({ central: asProject(), rows: renamed });

      const data = await dataOf<HistoryListData>('history_list', {}, w.ctx);

      expect(data.sessions.map((x) => x.id)).toEqual(['n1', 'n2']);
      expect(w.seen).toHaveLength(1);
    });

    it('breaks a tie between the folders’ rows by id, the larger id first, as the route does inside one folder', async () => {
      const tie = [row('t-a', '/a/proj', { started_at: 50 }), row('t-b', '/a/proj/sub', { started_at: 50 }), row('t-c', '/a/proj', { started_at: 50 })];

      expect(await idsOf({ central: asProject(), rows: tie })).toEqual(['t-c', 't-b', 't-a']);
    });

    it('puts two folders’ rows in the order the whole history would, however far into them a page reaches', async () => {
      const a = Array.from({ length: 450 }, (_, i) => row(`a${String(i).padStart(3, '0')}`, '/a/proj', { started_at: 100_000 - 2 * i }));
      const b = Array.from({ length: 450 }, (_, i) => row(`b${String(i).padStart(3, '0')}`, '/a/proj/sub', { started_at: 100_000 - 2 * i - 1 }));
      const expected = [...a, ...b].sort((x, y) => (y.started_at as number) - (x.started_at as number)).map((r) => r.id);

      for (const page of [1, 3, 5, 9]) {
        const data = await dataOf<HistoryListData>('history_list', { page, pageSize: 100 }, worldOf({ central: asProject(), rows: [...a, ...b] }).ctx);

        expect(data.sessions.map((x) => x.id), `page ${page}`).toEqual(expected.slice((page - 1) * 100, page * 100));
      }
    });

    it('reads one more route page of a folder only when the merge needs it, and never of one it has finished', async () => {
      const newer = Array.from({ length: 450 }, (_, i) => row(`n${i}`, '/a/proj', { started_at: 100_000 - i }));
      const older = Array.from({ length: 10 }, (_, i) => row(`o${i}`, '/a/proj/sub', { started_at: 10 - i }));
      const w = worldOf({ central: asProject(), rows: [...newer, ...older] });

      const data = await dataOf<HistoryListData>('history_list', { page: 3, pageSize: 100 }, w.ctx);

      expect(data.sessions.map((x) => x.id)).toEqual(Array.from({ length: 100 }, (_, i) => `n${200 + i}`));
      const asked = w.seen.map((q) => [q.project, q.page]).sort();
      expect(asked).toEqual([['/a/proj', 1], ['/a/proj', 2], ['/a/proj/sub', 1]]);
    });

    it('finds a folder’s rows under any amount of newer history in other folders: it asks the route for the folder, not for everything', async () => {
      const buried = [
        ...Array.from({ length: 2_000 }, (_, i) => row(`x${i}`, '/b/other', { started_at: 100_000 - i })),
        row('mine-1', '/a/proj', { started_at: 5 }),
        row('mine-2', '/a/proj/sub', { started_at: 4 }),
      ];
      const w = worldOf({ central: asProject(), rows: buried });

      const result = await run('history_list', {}, w.ctx);

      expect((result.data as HistoryListData).sessions.map((x) => x.id)).toEqual(['mine-1', 'mine-2']);
      expect(result.data).toMatchObject({ hasMore: false, capped: false });
      expect(w.seen).toHaveLength(2);
      expect(result.summary).not.toMatch(/stopped|ask for page/);
    });

    it('reads the history whole, 200 rows a page, and cuts it here, when there are more folders to ask about than 6', async () => {
      const seven = Array.from({ length: 7 }, (_, i) => row(`m${i}`, `/a/proj/m${i}`, { started_at: 50 + i }));
      const other = Array.from({ length: 450 }, (_, i) => row(`x${i}`, '/b/other', { started_at: 10_000 - i }));
      const w = worldOf({ central: asProject(), rows: [...other, ...seven] });

      const data = await dataOf<HistoryListData>('history_list', {}, w.ctx);

      expect(data.sessions.map((x) => x.id)).toEqual(['m6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0']);
      expect(w.seen.map((q) => [q.project, q.page, q.pageSize])).toEqual([[undefined, 1, 200], [undefined, 2, 200], [undefined, 3, 200]]);
      expect(data.hasMore).toBe(false);
    });

    it('pages what a scoped central may see: page 2 of 50 starts at its 51st row, not the route’s', async () => {
      const mine = Array.from({ length: 70 }, (_, i) => row(`m${String(i).padStart(2, '0')}`, '/a/proj', { started_at: 10_000 - 2 * i }));
      const theirs = Array.from({ length: 70 }, (_, i) => row(`o${i}`, '/b/other', { started_at: 10_000 - 2 * i - 1 }));

      const second = await dataOf<HistoryListData>('history_list', { page: 2 }, worldOf({ central: asProject(), rows: [...mine, ...theirs] }).ctx);

      expect(second.sessions.map((x) => x.id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${50 + i}`));
      expect(second.hasMore).toBe(false);
    });

    it('asks for the next page by number when it has already seen a row beyond this one', async () => {
      const many = Array.from({ length: 60 }, (_, i) => row(`m${String(i).padStart(2, '0')}`, '/a/proj', { started_at: 10_000 - i }));

      const first = await run('history_list', {}, worldOf({ central: asProject(), rows: many }).ctx);
      const second = await run('history_list', { page: 2 }, worldOf({ central: asProject(), rows: many }).ctx);

      expect(first.summary).toContain('There is more: ask for page 2.');
      expect(first.data).toMatchObject({ hasMore: true, capped: false });
      expect(second.summary).not.toMatch(/ask for page|stopped/);
    });

    describe('when its read reaches its limit (8 route pages) before the end', () => {
      const hidden = Array.from({ length: 2_000 }, (_, i) => row(`x${i}`, '/b/other', { started_at: 100_000 - i }));
      // Seven folders inside the project: more than it asks the route about one by one, so it reads the history whole.
      const seven = Array.from({ length: 7 }, (_, i) => row(`m${i}`, `/a/proj/m${i}`, { started_at: 50 + i }));

      it('says how far it looked, and that older rows may match, and which filters reach them, instead of saying nothing matches', async () => {
        const w = worldOf({ central: asProject(), rows: [...hidden, ...seven] });

        const result = await run('history_list', {}, w.ctx);

        expect(w.seen).toHaveLength(8);
        expect(result.data).toMatchObject({ count: 0, total: null, hasMore: true, capped: true });
        expect(result.summary).toMatch(/It read 1600 sessions/);
        expect(result.summary).toMatch(/Older ones may match/);
        expect(result.summary).toMatch(/narrow it with project \(one folder\), dateFrom and dateTo, status or query/);
        expect(result.summary).not.toMatch(/No sessions in the history match/);
        expect(result.summary).not.toMatch(/ask for page/);
      });

      it('lets the filters it points to reach what it could not: dates older than what it read find the rest', async () => {
        const w = worldOf({ central: asProject(), rows: [...hidden, ...seven] });

        const result = await run('history_list', { dateTo: '1970-01-01T00:00:00.100Z' }, w.ctx);

        expect((result.data as HistoryListData).sessions).toHaveLength(7);
        expect(result.data).toMatchObject({ hasMore: false, capped: false });
        expect(result.summary).not.toMatch(/stopped/);
      });

      it('names the one folder that narrows it to rows it can reach', async () => {
        const w = worldOf({ central: asProject(), rows: [...hidden, ...seven] });

        const result = await run('history_list', { project: '/a/proj/m3' }, w.ctx);

        expect((result.data as HistoryListData).sessions.map((x) => x.id)).toEqual(['m3']);
        expect(w.seen).toHaveLength(1);
        expect(w.seen[0]).toMatchObject({ project: '/a/proj/m3' });
      });
    });

    describe('when a page asked for lies past what one question can read, even in one folder', () => {
      const deep = Array.from({ length: 1_700 }, (_, i) => row(`d${String(i).padStart(4, '0')}`, '/a/proj', { started_at: 100_000 - i }));
      const ask = async (page: number) => await run('history_list', { page, pageSize: 100 }, worldOf({ central: asProject(), rows: deep }).ctx);

      it('still asks for the next page by number while a row beyond this one has been seen', async () => {
        const result = await ask(15);

        expect((result.data as HistoryListData).count).toBe(100);
        expect(result.data).toMatchObject({ hasMore: true, capped: false });
        expect(result.summary).toContain('There is more: ask for page 16.');
      });

      it('shows what it has of a page it cannot fill, says where it stopped and which filters go further, and does not offer another page', async () => {
        const result = await ask(16);

        expect((result.data as HistoryListData).count).toBe(100);
        expect(result.data).toMatchObject({ hasMore: true, capped: true });
        expect(result.summary).toMatch(/stopped after reading 1600 sessions/);
        expect(result.summary).toMatch(/narrow it with project \(one folder\), dateFrom and dateTo, status or query/);
        expect(result.summary).not.toMatch(/ask for page/);
      });

      it('says where it stopped for an empty page too, rather than that nothing matches', async () => {
        const result = await ask(17);

        expect(result.data).toMatchObject({ count: 0, hasMore: true, capped: true });
        expect(result.summary).toMatch(/It read 1600 sessions and none was left to show here/);
        expect(result.summary).not.toMatch(/No sessions in the history match|past the end/);
      });
    });

    it('passes a project that is inside the scope on to the route, and refuses one that is not without calling it', async () => {
      const w = worldOf({ central: asProject() });

      await run('history_list', { project: '/a/proj/sub' }, w.ctx);
      const refused = await runRefused('history_list', { project: '/b/other' }, w.ctx);

      expect(w.seen).toEqual([{ project: '/a/proj/sub', archived: 'all', page: 1, pageSize: 200 }]);
      expect(w.client.calls.map((c) => c.path)).toEqual(['/db/sessions']);
      expect(refused.code).toBe('NOT_IN_SCOPE');
      expect(`${refused.message} ${refused.hint}`).not.toContain('/b/other');
    });

    it('lets a room central ask for the folder of one of its sessions, and only that one', async () => {
      const w = worldOf({ central: asRoom() });

      expect((await runRefused('history_list', { project: '/a/proj/deeper/x' }, w.ctx)).code).toBe('NOT_IN_SCOPE');
      await expect(run('history_list', { project: '/a/proj/sub' }, w.ctx)).resolves.toBeDefined();
    });

    describe('Ruling 36: a row of a live session follows session scope', () => {
      // s1 is in room r1 (and live); live-out shares its folder but is in no room; ended-in shares it and has ended;
      // gone is known only to the history. All four ran in /a/proj.
      const store = [...sessions, liveOut, endedIn];
      const same = [
        row('s1', '/a/proj', { started_at: 40 }),
        row('live-out', '/a/proj', { started_at: 30 }),
        row('ended-in', '/a/proj', { started_at: 20, status: 'ended' }),
        row('gone', '/a/proj', { started_at: 10, status: 'ended' }),
      ];

      it('keeps a live session outside a room central’s room out of its history, though its folder is one of the room’s', async () => {
        expect(await idsOf({ central: asRoom(), store, rows: same })).toEqual(['s1', 'ended-in', 'gone']);
      });

      it('still shows a room central an ended session in a folder of its room, and a session only the history knows', async () => {
        const ids = await idsOf({ central: asRoom(), store, rows: same });

        expect(ids).toContain('ended-in');
        expect(ids).toContain('gone');
        expect(ids).not.toContain('live-out');
      });

      it('keeps a live session on another machine out of a project central’s history, though its folder is inside the project', async () => {
        const remote = [row('s2', '/a/proj/sub', { started_at: 30 }), row('live-remote', '/a/proj/sub', { started_at: 20 }), row('old', '/a/proj/sub', { started_at: 10 })];

        expect(await idsOf({ central: asProject(), store: [...sessions, liveRemote], rows: remote })).toEqual(['s2', 'old']);
      });

      it('shows a global central every one of them: scope has nothing to cut', async () => {
        expect(await idsOf({ central: asGlobal(), store, rows: same })).toEqual(['s1', 'live-out', 'ended-in', 'gone']);
      });

      it('shows a live session that is in scope although the history has no folder for it, and reads the history whole to find it', async () => {
        const bare = makeSession('s-bare', { projectPath: '' });
        const roomBare = makeRoom('r-bare', ['s-bare']);
        const history = [row('s-bare', '', { started_at: 30 }), row('x1', '/a/proj', { started_at: 20 }), row('x2', '/b/other', { started_at: 10 })];
        const w = worldOf({ central: makeCentral('room', 'r-bare'), store: [bare], rooms: [roomBare], rows: history });

        const data = await dataOf<HistoryListData>('history_list', {}, w.ctx);

        expect(data.sessions.map((x) => x.id)).toEqual(['s-bare']);
        expect(w.seen.map((q) => q.project)).toEqual([undefined]);
      });
    });
  });

  it('changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify({ sessions: rows, total: 2, page: 1, pageSize: 50 })));
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': ok(frozen) } });

    await expect(run('history_list', {}, ctx)).resolves.toBeDefined();
  });
});

interface DetailData {
  id: string;
  session: HistoryRowData;
  counts: { prompts: number; typedPrompts: number; responses: number; toolCalls: number; events: number; notes: number };
  prompts: Array<{ id: number; timestamp: number; text: string; textTruncated: boolean }>;
  responses: Array<{ id: number; timestamp: number; text: string }>;
  tools: Array<{ name: string; count: number }>;
  notes: Array<{ id: number; createdAt: number; updatedAt: number; text: string }>;
}

describe('history_get', () => {
  const detail = (project = '/a/proj', over: Record<string, unknown> = {}) => ({
    session: row('h1', project, { summary: 'S' }),
    prompts: [
      { id: 1, session_id: 'h1', text: 'first typed prompt', timestamp: 100 },
      { id: 2, session_id: 'h1', text: '<task-notification>agent chatter</task-notification>', timestamp: 150 },
      { id: 3, session_id: 'h1', text: '  <system-reminder>more chatter', timestamp: 160 },
      { id: 4, session_id: 'h1', text: 'second typed prompt', timestamp: 200 },
    ],
    responses: [{ id: 1, session_id: 'h1', text_excerpt: 'Done: login fixed', timestamp: 210 }],
    tool_calls: [
      { id: 1, session_id: 'h1', tool_name: 'Read', tool_input_summary: '{"file_path":"/a/x"}', timestamp: 110 },
      { id: 2, session_id: 'h1', tool_name: 'Edit', tool_input_summary: '{}', timestamp: 120 },
      { id: 3, session_id: 'h1', tool_name: 'Read', tool_input_summary: '{}', timestamp: 130 },
    ],
    events: [{ id: 1, session_id: 'h1', event_type: 'Stop', detail: '', timestamp: 220 }],
    notes: [{ id: 5, session_id: 'h1', text: 'a note to self', created_at: 300, updated_at: 310 }],
    ...over,
  });

  it('calls GET /db/sessions/<id>, the id written as one path segment', async () => {
    const { ctx, client } = makeCtx({ routes: { 'GET /db/sessions/h1': ok(detail()), 'GET /db/sessions/a%2Fb': ok(detail()) } });

    await run('history_get', { id: 'h1' }, ctx);
    await run('history_get', { id: 'a/b' }, ctx);

    expect(client.calls.map((c) => c.path)).toEqual(['/db/sessions/h1', '/db/sessions/a%2Fb']);
  });

  it('describes the session and counts what it holds, the prompts a person typed apart from the harness’s', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions/h1': ok(detail()) } });

    const data = await dataOf<DetailData>('history_get', { id: 'h1' }, ctx);

    expect(data.id).toBe('h1');
    expect(data.session).toMatchObject({ id: 'h1', project: { path: '/a/proj' }, status: 'ended', prompts: 3, toolCalls: 7 });
    expect(data.counts).toEqual({ prompts: 4, typedPrompts: 2, responses: 1, toolCalls: 3, events: 1, notes: 1 });
    expect(data.tools).toEqual([{ name: 'Read', count: 2 }, { name: 'Edit', count: 1 }]);
  });

  it('lists the newest typed prompts first, the responses and the notes, each text fenced', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions/h1': ok(detail()) } });

    const data = await dataOf<DetailData>('history_get', { id: 'h1' }, ctx);

    expect(data.prompts.map((p) => p.id)).toEqual([4, 1]);
    for (const p of data.prompts) expectFenced(p.text, 'prompt', 'session:h1');
    expectFenced(data.responses[0].text, 'response', 'session:h1');
    expectFenced(data.notes[0].text, 'note', 'session:h1');
    expect(data.notes[0]).toMatchObject({ id: 5, createdAt: 300, updatedAt: 310 });
    expectFenced(data.session.title, 'title', 'session:h1');
    expectFenced(data.session.summary, 'summary', 'session:h1');
    expect(everything({ data, summary: '' })).not.toContain('agent chatter');
  });

  it('shows the 20 newest prompts, the 10 newest responses and the 10 newest notes, each cut short', async () => {
    const big = detail('/a/proj', {
      prompts: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, text: 'p'.repeat(3_000), timestamp: i })),
      responses: Array.from({ length: 15 }, (_, i) => ({ id: i + 1, text_excerpt: `r${i}`, timestamp: i })),
      notes: Array.from({ length: 14 }, (_, i) => ({ id: i + 1, text: `n${i}`, created_at: i, updated_at: i })),
    });
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions/h1': ok(big) } });

    const result = await run('history_get', { id: 'h1' }, ctx);
    const data = result.data as DetailData;

    expect(data.prompts).toHaveLength(20);
    expect(data.prompts[0].id).toBe(30);
    expect(data.prompts[0].textTruncated).toBe(true);
    expect(data.prompts[0].text.length).toBeLessThan(1_200);
    expect(data.responses).toHaveLength(10);
    expect(data.responses[0].id).toBe(15);
    expect(data.notes).toHaveLength(10);
    expect(data.counts).toMatchObject({ prompts: 30, responses: 15, notes: 14 });
    expect(result.summary.length).toBeLessThan(20_000);
  });

  it('keeps hostile text inside fences: everything a session wrote is in blocks', async () => {
    const evil = detail('/a/proj', {
      session: row('h1', '/a/proj', { title: HOSTILE, summary: HOSTILE, remark: HOSTILE }),
      prompts: [{ id: 1, text: HOSTILE, timestamp: 1 }],
      responses: [{ id: 1, text_excerpt: HOSTILE, timestamp: 1 }],
      notes: [{ id: 1, text: HOSTILE, created_at: 1, updated_at: 1 }],
    });
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions/h1': ok(evil) } });

    const result = await run('history_get', { id: 'h1' }, ctx);

    expect(blocksIn(result.summary)).toBeGreaterThan(0);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('answers a session the history does not have as not found, never repeating the id', async () => {
    const needle = 'history-needle-77';
    const { ctx } = makeCtx({ routes: { [`GET /db/sessions/${needle}`]: fail(404, 'Session not found') } });

    const err = await runRefused('history_get', { id: needle }, ctx);

    expect(err.code).toBe('NOT_FOUND');
    expect(`${err.message} ${err.hint}`).not.toContain(needle);
  });

  describe('scope (Rulings 32 and 36)', () => {
    const open = (central: ReturnType<typeof makeCentral>, project: string) =>
      makeCtx({ central, sessions, rooms, routes: { 'GET /db/sessions/h1': ok(detail(project)) } }).ctx;
    /** The session `id`, which ran in `project`, opened by `central`, with `store` as the sessions the Mac holds. */
    const openSession = (central: ReturnType<typeof makeCentral>, id: string, project: string, store: ReturnType<typeof makeSession>[]) =>
      makeCtx({ central, sessions: store, rooms, routes: { [`GET /db/sessions/${id}`]: ok(detail(project, { session: row(id, project) })) } }).ctx;

    it('gives a global central any session', async () => {
      await expect(run('history_get', { id: 'h1' }, open(asGlobal(), '/b/other'))).resolves.toBeDefined();
    });

    it('gives a project central a session inside its folder, and refuses one outside it, saying nothing of it', async () => {
      await expect(run('history_get', { id: 'h1' }, open(asProject(), '/a/proj/deeper/x'))).resolves.toBeDefined();

      const err = await runRefused('history_get', { id: 'h1' }, open(asProject(), '/b/other'));
      expect(err.code).toBe('NOT_IN_SCOPE');
      expect(`${err.message} ${err.hint}`).not.toMatch(/b\/other|Title of/);
    });

    it('gives a room central a session in one of its sessions’ folders, and refuses any other, below them too', async () => {
      await expect(run('history_get', { id: 'h1' }, open(asRoom(), '/a/proj/sub'))).resolves.toBeDefined();

      expect((await runRefused('history_get', { id: 'h1' }, open(asRoom(), '/a/proj/deeper/x'))).code).toBe('NOT_IN_SCOPE');
      expect((await runRefused('history_get', { id: 'h1' }, open(asRoom(), '/b/other'))).code).toBe('NOT_IN_SCOPE');
    });

    it('refuses a session with no folder to a central that is scoped', async () => {
      expect((await runRefused('history_get', { id: 'h1' }, open(asProject(), ''))).code).toBe('NOT_IN_SCOPE');
    });

    it('refuses a LIVE session outside a room central’s room even where its folder is one of the room’s (Ruling 36), saying nothing of it', async () => {
      const err = await runRefused('history_get', { id: 'live-out' }, openSession(asRoom(), 'live-out', '/a/proj', [...sessions, liveOut]));

      expect(err.code).toBe('NOT_IN_SCOPE');
      expect(`${err.message} ${err.hint}`).not.toMatch(/Title of|a\/proj/);
    });

    it('gives a room central an ENDED session in a folder of its room, and one only the history knows (Ruling 36 leaves them to the folder rule)', async () => {
      await expect(run('history_get', { id: 'ended-in' }, openSession(asRoom(), 'ended-in', '/a/proj', [...sessions, endedIn]))).resolves.toBeDefined();
      await expect(run('history_get', { id: 'gone' }, openSession(asRoom(), 'gone', '/a/proj', sessions))).resolves.toBeDefined();
    });

    it('gives a central a live session that is in its scope', async () => {
      await expect(run('history_get', { id: 's1' }, openSession(asRoom(), 's1', '/a/proj', sessions))).resolves.toBeDefined();
      await expect(run('history_get', { id: 's2' }, openSession(asProject(), 's2', '/a/proj/sub', sessions))).resolves.toBeDefined();
    });

    it('refuses a live session on another machine to a project central, though its folder is inside the project', async () => {
      const err = await runRefused('history_get', { id: 'live-remote' }, openSession(asProject(), 'live-remote', '/a/proj/sub', [...sessions, liveRemote]));

      expect(err.code).toBe('NOT_IN_SCOPE');
    });

    it('gives a global central a live session whatever its scope', async () => {
      await expect(run('history_get', { id: 'live-out' }, openSession(asGlobal(), 'live-out', '/a/proj', [...sessions, liveOut]))).resolves.toBeDefined();
    });
  });
});

describe('history_projects', () => {
  const projects = FOLDERS.map((p) => ({ project_path: p, project_name: p.split('/').pop() ?? '' }));
  const routes = { 'GET /db/projects': ok(projects) };

  it('calls GET /db/projects', async () => {
    const { ctx, client } = makeCtx({ routes });

    await run('history_projects', {}, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/db/projects' }]);
  });

  it('lists every project folder the history has, for a global central', async () => {
    const { ctx } = makeCtx({ routes });

    const data = await dataOf<{ count: number; projects: Array<{ path: string; name: string }> }>('history_projects', {}, ctx);

    expect(data.count).toBe(6);
    expect(data.projects[0]).toEqual({ path: '/a/proj', name: 'proj' });
    expect(data.projects.map((p) => p.path)).not.toContain('');
  });

  it('lists a project central only the folders inside its own, and a room central only its sessions’ folders', async () => {
    const forProject = makeCtx({ central: asProject(), sessions, rooms, routes });
    const forRoom = makeCtx({ central: asRoom(), sessions, rooms, routes });

    const inProject = await run('history_projects', {}, forProject.ctx);
    const inRoom = await run('history_projects', {}, forRoom.ctx);

    expect((inProject.data as { projects: Array<{ path: string }> }).projects.map((p) => p.path)).toEqual(['/a/proj', '/a/proj/sub', '/a/proj/deeper/x']);
    expect((inRoom.data as { projects: Array<{ path: string }> }).projects.map((p) => p.path)).toEqual(['/a/proj', '/a/proj/sub']);
    expect(everything(inRoom)).not.toMatch(/b\/other|a\/other|project2/);
  });

  it('pages 100 to a page, up to 500, and puts the rows in one block', async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ project_path: `/p/${i}`, project_name: `${i}` }));
    const { ctx } = makeCtx({ routes: { 'GET /db/projects': ok(many) } });

    const first = await run('history_projects', {}, ctx);
    const next = (first.data as { nextCursor: string | null }).nextCursor;
    const second = await dataOf<{ count: number; returned: number; nextCursor: string | null }>('history_projects', { cursor: next ?? '' }, ctx);

    expect(first.data).toMatchObject({ count: 130, returned: 100, nextCursor: '100' });
    expect(second).toMatchObject({ returned: 30, nextCursor: null });
    expect(blocksIn(first.summary)).toBe(1);
    await expect(run('history_projects', { limit: 501 }, ctx)).rejects.toThrow(/limit/);
  });

  it('says so when there are none, and keeps hostile names inside the block', async () => {
    const empty = makeCtx({ routes: { 'GET /db/projects': ok([]) } });
    const evil = makeCtx({ routes: { 'GET /db/projects': ok([{ project_path: '/a/x', project_name: HOSTILE }]) } });

    expect((await run('history_projects', {}, empty.ctx)).summary).toMatch(/No projects/);
    expect(outsideFences((await run('history_projects', {}, evil.ctx)).summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });
});

describe('history_known_projects', () => {
  const paths = ['/a/proj', '/a/proj/sub', '/a/proj/deeper/x', '/a/other', '/b/other'];
  const routes = { 'GET /known-projects': ok({ paths }) };

  it('calls GET /known-projects', async () => {
    const { ctx, client } = makeCtx({ routes });

    await run('history_known_projects', {}, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/known-projects' }]);
  });

  it('lists the folders Claude Code has run in, cut to what each kind of central may see', async () => {
    const list = async (central: ReturnType<typeof makeCentral>) =>
      (await dataOf<{ paths: string[] }>('history_known_projects', {}, makeCtx({ central, sessions, rooms, routes }).ctx)).paths;

    expect(await list(asGlobal())).toEqual([...paths].sort());
    expect(await list(asProject())).toEqual(['/a/proj', '/a/proj/deeper/x', '/a/proj/sub']);
    expect(await list(asRoom())).toEqual(['/a/proj', '/a/proj/sub']);
  });

  it('pages in path order, not the route’s most-used-first order (which moves with every hook)', async () => {
    const ranked = ['/z/busy', '/a/quiet', '/m/mid'];
    const { ctx } = makeCtx({ routes: { 'GET /known-projects': ok({ paths: ranked }) } });

    expect((await dataOf<{ paths: string[] }>('history_known_projects', {}, ctx)).paths).toEqual(['/a/quiet', '/m/mid', '/z/busy']);
  });

  it('pages, and says so when there are none', async () => {
    const many = Array.from({ length: 150 }, (_, i) => `/p/${i}`);
    const full = makeCtx({ routes: { 'GET /known-projects': ok({ paths: many }) } });
    const none = makeCtx({ routes: { 'GET /known-projects': ok({ paths: [] }) } });

    expect(await dataOf('history_known_projects', {}, full.ctx)).toMatchObject({ count: 150, returned: 100, nextCursor: '100' });
    expect((await run('history_known_projects', {}, none.ctx)).summary).toMatch(/No folders/);
  });

  it('skips what is not a path, and changes nothing it reads', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /known-projects': ok(deepFreeze({ paths: ['/a/x', 7, null, ''] })) } });

    expect((await dataOf<{ paths: string[] }>('history_known_projects', {}, ctx)).paths).toEqual(['/a/x']);
  });
});
