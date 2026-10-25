// test/mcp/router.test.ts — the router (server/mcp/router.ts): scope → project → handoff → eligible → score → reuse or
// create, with the reasons it gives. A route is a dry run: it reads (GET /resources, /db/*, /known-projects,
// /sessions/:id/changes) and never opens or types anything, which the tests hold it to. Nothing here touches the disk:
// the home folder is fake and every folder "exists".
import { describe, expect, it, vi } from 'vitest';
import { unwiredLedger } from '../../server/mcp/deliver.js';
import { explain, route } from '../../server/mcp/router.js';
import type { Ledger } from '../../server/mcp/ledger.js';
import { routerSettings } from '../../server/mcp/routerConfig.js';
import type { Session } from '../../src/types/session.js';
import { deepFreeze } from './readFixtures.js';
import { fail, makeCentral, makeCtx, makeRoom, NOW, ok, type CtxOptions } from './toolHarness.js';
import {
  A, AGENT, B, C, GLOBAL, HOME, MIN, ROUTES, SITE, TASK,
  childCentral, emptyRoutes, go, idsOf, reuseOf, refused, routeDeps, withContext, worker,
} from './routerFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

describe('route: reuse', () => {
  it('reuses the best-scoring eligible session in the project', async () => {
    const a = worker(A, AGENT, { ...withContext(23), lastActivityAt: NOW - 10 * MIN });
    const b = worker(B, AGENT);

    const r = await go({ sessions: [b, a] }).result;

    expect(r.decision).toMatchObject({ kind: 'reuse', sessionId: A, score: 7 });
    expect(r.decision.reasons).toEqual(['same folder', 'idle', 'ctx 23 %', 'active 10m ago']);
    expect(r.confidence).toBe('high');
    expect(r.project).toEqual({ folder: AGENT, source: expect.stringMatching(/name/) });
    expect(r.runnersUp).toEqual([{ sessionId: B, shortId: 'sess-bbb', score: 5, reasons: ['same folder', 'idle'] }]);
  });

  it('reuse stays inside the project', async () => {
    const inside = worker(B, AGENT);
    // Better on every term but the folder: idle, recent, headroom, and the task's own words in its title.
    const other = worker(A, SITE, { ...withContext(10), lastActivityAt: NOW - MIN, title: 'flaky queue test' });

    const r = await go({ sessions: [other, inside] }).result;

    expect(reuseOf(r)).toBe(B);
    expect(idsOf(r.runnersUp)).toEqual([]);

    const alone = await go({ sessions: [other] }).result;
    expect(alone.decision.kind).toBe('create');
    expect(idsOf(alone.runnersUp)).toEqual([]);
  });

  it('a session in a folder below the project is inside it', async () => {
    const below = worker(A, `${AGENT}/packages/web`, { ...withContext(10), lastActivityAt: NOW - MIN });

    const r = await go({ sessions: [below] }).result;

    expect(r.decision).toMatchObject({ kind: 'reuse', sessionId: A, score: 4 });
    expect(r.decision.reasons).not.toContain('same folder');
  });

  it('a human-active session is not eligible', async () => {
    const typed = worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN });
    const quiet = worker(B, AGENT);
    const controller = (id: string) => (id === A ? { clientId: 'window-1', lastActivityAt: NOW - 10_000 } : null);

    const r = await go({ sessions: [typed, quiet], controller }).result;

    expect(reuseOf(r)).toBe(B);
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: A, score: 7, skipped: 'HUMAN_ACTIVE' })]);
  });

  it('a working session is not eligible', async () => {
    const busy = worker(A, AGENT, { status: 'working', ...withContext(10), lastActivityAt: NOW - MIN });
    const idle = worker(B, AGENT);

    const r = await go({ sessions: [busy, idle] }).result;

    expect(reuseOf(r)).toBe(B);
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: A, skipped: 'working' })]);

    const onlyBusy = await go({ sessions: [busy] }).result;
    expect(onlyBusy.decision.kind).toBe('create');
    expect(onlyBusy.runnersUp).toEqual([expect.objectContaining({ sessionId: A, skipped: 'working' })]);
  });

  it('a session that is hands-off, or holds a task, is skipped with the policy’s code', async () => {
    const handsOff = worker(A, AGENT, { handsOff: true, ...withContext(10), lastActivityAt: NOW - MIN });
    const locked = worker(B, AGENT, { ...withContext(10) });
    const free = worker(C, AGENT);
    const ledger: Ledger = { ...unwiredLedger, isLocked: (id) => id === B };

    const r = await go({ sessions: [handsOff, locked, free], ledger }).result;

    expect(reuseOf(r)).toBe(C);
    expect(r.runnersUp.map((c) => [c.sessionId, c.skipped])).toEqual([[A, 'HANDS_OFF'], [B, 'BUSY']]);
  });

  it('context at 80 % is not eligible', async () => {
    const full = worker(A, AGENT, withContext(80));
    const nearly = worker(B, AGENT, withContext(79));

    const r = await go({ sessions: [full, nearly] }).result;

    expect(reuseOf(r)).toBe(B);
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: A, skipped: 'context at 80 %' })]);
  });

  it('best score below 4 creates', async () => {
    // Below the project folder (no same-folder term), idle, nothing else: 2.
    const weak = worker(A, `${AGENT}/packages/web`);

    const r = await go({ sessions: [weak] }).result;

    expect(r.decision.kind).toBe('create');
    expect(r.decision.reasons.join(' ')).toMatch(/scored 2/);
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: A, score: 2 })]);
    expect(r.runnersUp[0].skipped).toBeUndefined();
  });

  it('the threshold is the configured one', async () => {
    const weak = worker(A, `${AGENT}/packages/web`);

    const lowered = routeDeps({ settings: routerSettings({ router: { reuseThreshold: 2 } }) });

    expect((await go({ sessions: [weak] }, {}, lowered).result).decision).toMatchObject({ kind: 'reuse', sessionId: A });
  });

  it('newOnly always creates, and never asks the policy about a session', async () => {
    const a = worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN });
    const h = makeCtx({ sessions: [a], routes: emptyRoutes() });
    const asked: string[] = [];
    const ctx = { ...h.ctx, mayDrive: (s: Session) => { asked.push(s.sessionId); h.ctx.mayDrive(s); } };

    const r = await route(ctx, { task: TASK, newOnly: true }, routeDeps());

    expect(r.decision).toMatchObject({ kind: 'create', folder: AGENT });
    expect(r.decision.reasons.join(' ')).toMatch(/new session was asked for/);
    expect(asked).toEqual([]);
    expect(idsOf(r.runnersUp)).toEqual([A]);
  });

  it('asks the policy only about sessions that could win', async () => {
    const sessions = [
      worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN }), // 7
      worker(B, AGENT), // 5
      worker('sess-ddd4', `${AGENT}/packages/web`), // 2: under the threshold
    ];
    const controller = (id: string) => (id === A ? { clientId: 'window-1', lastActivityAt: NOW - 10_000 } : null);
    const h = makeCtx({ sessions, routes: emptyRoutes(), controller });
    const asked: string[] = [];
    const ctx = { ...h.ctx, mayDrive: (s: Session) => { asked.push(s.sessionId); h.ctx.mayDrive(s); } };

    const r = await route(ctx, { task: TASK }, routeDeps());

    expect(reuseOf(r)).toBe(B);
    expect(asked).toEqual([A, B]);
  });

  it('on equal scores the more recently active session wins, then the lower id, whatever the order they came in', async () => {
    const older = worker(A, AGENT, { lastActivityAt: NOW - 120 * MIN });
    const newer = worker(B, AGENT, { lastActivityAt: NOW - 90 * MIN });
    expect(reuseOf(await go({ sessions: [older, newer] }).result)).toBe(B);
    expect(reuseOf(await go({ sessions: [newer, older] }).result)).toBe(B);

    const twinA = worker(A, AGENT);
    const twinB = worker(B, AGENT);
    expect(reuseOf(await go({ sessions: [twinB, twinA] }).result)).toBe(A);
    expect(reuseOf(await go({ sessions: [twinA, twinB] }).result)).toBe(A);
  });

  it('on equal scores a session that can be used is listed before one that cannot', async () => {
    // Both sit below the project folder and score 2: the idle one for being idle, the busy one for headroom and
    // recent activity. The busy one is the more recently active, which would put it first without the rule.
    const below = `${AGENT}/packages/web`;
    const usable = worker(A, below, { lastActivityAt: NOW - 90 * MIN });
    const busy = worker(B, below, { status: 'working', lastActivityAt: NOW - MIN, ...withContext(10) });

    const r = await go({ sessions: [busy, usable] }).result;

    expect(r.decision.kind).toBe('create');
    expect(r.runnersUp.map((c) => [c.sessionId, c.score, c.skipped])).toEqual([
      [A, 2, undefined],
      [B, 2, 'working'],
    ]);
  });

  it('exclude drops a session (re-route)', async () => {
    const a = worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN });
    const b = worker(B, AGENT);

    const r = await go({ sessions: [a, b] }, { exclude: [A] }).result;

    expect(reuseOf(r)).toBe(B);
    expect(idsOf(r.runnersUp)).toEqual([]);

    // The id the central was given may since have been re-keyed.
    const rekeyed = await go({ sessions: [a, b], aliases: { 'term-old': A } }, { exclude: ['term-old'] }).result;
    expect(reuseOf(rekeyed)).toBe(B);
    expect(idsOf(rekeyed.runnersUp)).toEqual([]);

    const noneLeft = await go({ sessions: [a] }, { exclude: [A] }).result;
    expect(noneLeft.decision.kind).toBe('create');
  });

  it('only a session of the CLI asked for is eligible', async () => {
    const claude = worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN });
    const codex = worker(B, AGENT, { cliSource: 'codex' });

    const wantsCodex = await go({ sessions: [claude, codex] }, { cli: 'codex' }).result;
    expect(reuseOf(wantsCodex)).toBe(B);
    expect(wantsCodex.runnersUp).toEqual([expect.objectContaining({ sessionId: A, skipped: 'runs claude' })]);

    const wantsAny = await go({ sessions: [claude, codex] }).result;
    expect(reuseOf(wantsAny)).toBe(A);
  });

  it('the explanation names the winner and the runner-up', async () => {
    const winner = worker(A, AGENT, { ...withContext(23), lastActivityAt: NOW - 10 * MIN });
    // The runner-up: busy, but its title carries the task's words, so it scores 6.
    const busy = worker(C, AGENT, { status: 'working', lastActivityAt: NOW - MIN, title: 'flaky queue test' });

    const r = await go({ sessions: [winner, busy] }).result;
    const text = explain(r);

    expect(text).toBe('routed to #sess-aaa: same folder, idle, ctx 23 %, active 10m ago; runner-up #sess-ccc working');
    expect(r.runnersUp[0]).toMatchObject({ sessionId: C, score: 6, skipped: 'working' });
    expect(text.length).toBeLessThanOrEqual(300);
    // AASC's words and ids only: nothing the task, a title or a folder said.
    for (const leaked of ['flaky', 'queue', 'agent-manager', 'tester']) expect(text).not.toContain(leaked);
  });

  it('explains a new session, and says when the project was a guess', async () => {
    const busy = worker(A, AGENT, { status: 'working' });

    const r = await go({ sessions: [busy] }, { task: 'tidy up the backlog' }).result;

    expect(r.confidence).toBe('low');
    expect(r.decision.kind).toBe('create');
    expect(explain(r)).toMatch(/^opens a new session: every session in the project is busy or unavailable.* \(low confidence in the project\); runner-up #sess-aaa working$/);
    expect(explain(r).length).toBeLessThanOrEqual(300);
  });

  it('lists at most the configured number of runners-up, best first', async () => {
    const sessions = [1, 2, 3, 4, 5].map((n) => worker(`sess-${n}${n}${n}${n}`, AGENT, { lastActivityAt: NOW - (n + 100) * MIN }));
    const strong = worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN });

    const r = await go({ sessions: [...sessions, strong] }, {}, routeDeps({ settings: routerSettings({ router: { runnersUp: 3 } }) })).result;

    expect(reuseOf(r)).toBe(A);
    expect(r.runnersUp).toHaveLength(3);
    expect(r.runnersUp.every((c) => c.score === 5)).toBe(true);
  });

  it('reads and nothing else: no session is opened and nothing is typed', async () => {
    const a = worker(A, AGENT);

    const h = go({ sessions: [a] });
    await h.result;

    expect(h.client.calls.length).toBeGreaterThan(0);
    expect(h.client.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('changes nothing it is given', async () => {
    const sessions = deepFreeze([worker(A, AGENT, withContext(10)), worker(B, AGENT)]);
    const rooms = deepFreeze([makeRoom('r1', [A])]);

    await expect(go({ sessions, rooms }).result).resolves.toMatchObject({ decision: { kind: 'reuse' } });
  });
});

describe('route: create', () => {
  const ended = (over: Partial<Session> = {}) =>
    worker(A, AGENT, {
      status: 'ended', endedAt: NOW - MIN, cliSource: 'codex', model: 'gpt-5.1-codex', effortLevel: 'high', ...over,
    });

  it('create takes the profile’s cli, model, effort and room', async () => {
    const r = await go({ sessions: [ended()], rooms: [makeRoom('r7', [A])] }, { task: TASK }).result;

    expect(r.decision).toEqual({
      kind: 'create',
      folder: AGENT,
      cli: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'high',
      roomId: 'r7',
      title: TASK,
      reasons: expect.any(Array),
    });
    expect(r.decision.reasons).toEqual(['no session in the project', 'settings copied from the project’s newest session']);
    expect(r.runnersUp).toEqual([]);
  });

  it('says where a new session’s settings came from: the newest session, history, another CLI, or nothing', async () => {
    const reasonsOf = async (opts: CtxOptions, input: Record<string, unknown> = {}) => {
      const r = await go(opts, input).result;
      return r.decision.reasons.slice(1);
    };
    const live = { sessions: [ended()], rooms: [] };
    const history = emptyRoutes({
      'GET /db/projects': ok([{ project_path: AGENT, project_name: 'agent-manager' }]),
      'GET /db/sessions': ok({ sessions: [{ id: 'h1', model: 'gpt-5.1-codex' }] }),
    });

    expect(await reasonsOf(live)).toEqual(['settings copied from the project’s newest session']);
    expect(await reasonsOf({ sessions: [], routes: history })).toEqual(['settings copied from the project’s last session']);
    expect(await reasonsOf(live, { cli: 'claude' })).toEqual(['earlier sessions used another CLI, so no model or effort was copied']);
    expect(await reasonsOf({ sessions: [] }, { project: AGENT })).toEqual(['nothing earlier to copy: it starts as this central runs']);
  });

  it('refuses a model name the terminal route would silently drop', async () => {
    for (const model of ['Opus 4.8', 'claude opus', 'a;b', '', 'x'.repeat(101)]) {
      const err = await refused(go({ sessions: [] }, { project: AGENT, model }).result);
      expect(err.code, model).toBe('INVALID');
      expect(err.message, model).not.toContain('Opus');
    }
    for (const model of ['claude-opus-5-5', 'gpt-5.1-codex', 'o3_mini.v2']) {
      expect((await go({ sessions: [] }, { project: AGENT, model }).result).decision).toMatchObject({ kind: 'create', model });
    }
  });

  it('takes the model and effort from the profile only for the CLI the profile used', async () => {
    const sessions = [ended()];
    const rooms = [makeRoom('r7', [A])];

    const other = await go({ sessions, rooms }, { cli: 'claude' }).result;
    expect(other.decision).toMatchObject({ kind: 'create', cli: 'claude', roomId: 'r7' });
    expect(other.decision).not.toHaveProperty('model');
    expect(other.decision).not.toHaveProperty('effort');

    const explicit = await go({ sessions, rooms }, { model: 'gpt-5.2-codex' }).result;
    expect(explicit.decision).toMatchObject({ cli: 'codex', model: 'gpt-5.2-codex', effort: 'high' });

    const named = await go({ sessions, rooms }, { cli: 'claude', model: 'claude-opus-5-5' }).result;
    expect(named.decision).toMatchObject({ cli: 'claude', model: 'claude-opus-5-5' });
  });

  it('carries a model and effort the route would accept, and drops what it would drop', async () => {
    const odd = ended({ cliSource: 'claude', model: 'Opus 4.8 (1M context)', effortLevel: 'turbo' });

    const r = await go({ sessions: [odd] }).result;

    expect(r.decision).toMatchObject({ kind: 'create', cli: 'claude' });
    expect(r.decision).not.toHaveProperty('model');
    expect(r.decision).not.toHaveProperty('effort');
  });

  it('with nothing known of the project, starts as the central itself runs, in no room', async () => {
    const claude = await go({ sessions: [] }, { project: AGENT }).result;
    expect(claude.decision).toEqual({ kind: 'create', folder: AGENT, cli: 'claude', title: TASK, reasons: expect.any(Array) });

    const codexCentral = makeCentral('global', null, { centralId: 'global-1', cli: 'codex' });
    const codex = await go({ central: codexCentral, sessions: [] }, { project: AGENT }).result;
    expect(codex.decision).toMatchObject({ kind: 'create', cli: 'codex' });
  });

  it('a project with history but no live card starts as its newest history row did', async () => {
    const routes = emptyRoutes({
      'GET /db/projects': ok([{ project_path: AGENT, project_name: 'agent-manager' }]),
      'GET /db/sessions': ok({ sessions: [{ id: 'h1', model: 'gpt-5.1-codex' }] }),
    });

    const r = await go({ sessions: [], routes }).result;

    expect(r.decision).toMatchObject({ kind: 'create', folder: AGENT, cli: 'codex', model: 'gpt-5.1-codex' });
  });

  it('a room central’s worker goes into its own room', async () => {
    const central = makeCentral('room', 'r1', { centralId: 'room-1' });
    const inRoom = worker(A, SITE, { status: 'working' });
    const elsewhere = ended({ sessionId: B });
    const rooms = [makeRoom('r1', [A]), makeRoom('r7', [B])];

    const r = await go({ central, sessions: [inRoom, elsewhere], rooms }, { project: AGENT }).result;

    expect(r.decision).toMatchObject({ kind: 'create', folder: AGENT, roomId: 'r1' });
  });

  it('the title is the task, on one line, cut to 60 characters at a word boundary', async () => {
    const long = 'refactor the   queue\nledger so that every task that fails is re-routed exactly once and never twice';

    const r = await go({ sessions: [] }, { task: long, project: AGENT }).result;

    if (r.decision.kind !== 'create') throw new Error('expected a create');
    expect(r.decision.title.length).toBeLessThanOrEqual(60);
    expect(r.decision.title).toBe('refactor the queue ledger so that every task that fails is…');
    expect(r.decision.title).not.toMatch(/[\r\n]/);
  });

  it('a title is never cut inside a word when there is a space to cut at', async () => {
    const task = `${'word '.repeat(11)}abcdefghijkl`;

    const r = await go({ sessions: [] }, { task, project: AGENT }).result;

    if (r.decision.kind !== 'create') throw new Error('expected a create');
    expect(r.decision.title).toBe(`${'word '.repeat(10)}word…`);
    expect(r.decision.title.length).toBeLessThanOrEqual(60);
  });

  it('a title that ends exactly on a word keeps that word', async () => {
    // Characters 55-58 are a whole word and the next character is a space: the cut falls on the boundary.
    const task = `${'word '.repeat(11)}abcd efgh ijkl`;

    const r = await go({ sessions: [] }, { task, project: AGENT }).result;

    if (r.decision.kind !== 'create') throw new Error('expected a create');
    expect(r.decision.title).toBe(`${'word '.repeat(11)}abcd…`);
    expect(r.decision.title.length).toBe(60);
  });

  it('a short task is its own title; a single word of 200 letters is cut hard', async () => {
    const short = await go({ sessions: [] }, { task: '  fix   it  ', project: AGENT }).result;
    expect(short.decision).toMatchObject({ title: 'fix it' });

    const word = await go({ sessions: [] }, { task: 'x'.repeat(200), project: AGENT }).result;
    if (word.decision.kind !== 'create') throw new Error('expected a create');
    expect(word.decision.title).toBe(`${'x'.repeat(59)}…`);
  });

  it('refuses a folder a central may not open, with the launch rule’s words', async () => {
    const scratch = worker(A, '/tmp/scratch', { status: 'working' });

    const err = await refused(go({ sessions: [scratch] }, { task: 'tidy up the backlog' }).result);

    expect(err.code).toBe('DENIED');
    expect(err.message).toMatch(/inside the home folder/);
    expect(err.message).not.toContain('scratch');
  });

  it('judges the folder by its real path, and refuses one that has gone', async () => {
    const live = worker(A, AGENT, { status: 'working' });

    const toSecret = routeDeps({ realpath: () => `${HOME}/.ssh/keys` });
    expect((await refused(go({ sessions: [live] }, {}, toSecret).result)).code).toBe('DENIED');

    const gone = routeDeps({ realpath: () => null });
    const err = await refused(go({ sessions: [live] }, {}, gone).result);
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/no longer there/);
  });

  it('refuses a folder that is outside home as written, even when a link there leads into home', async () => {
    const linked = worker(A, '/tmp/linked-project', { status: 'working' });
    const intoHome = routeDeps({ realpath: () => `${HOME}/code/real-project` });

    const err = await refused(go({ sessions: [linked] }, { task: 'tidy up the backlog' }, intoHome).result);

    expect(err.code).toBe('DENIED');
  });

  it('a known project may sit in a hidden folder: the known roots come from GET /known-projects', async () => {
    const hidden = `${HOME}/.openclaw/claw`;
    const live = worker(A, hidden, { status: 'working' });
    const routes = emptyRoutes({ 'GET /known-projects': ok({ paths: [hidden] }) });
    const { known: _unused, ...withoutKnown } = routeDeps();

    const r = await go({ sessions: [live], routes }, { task: 'work on claw today' }, withoutKnown).result;
    expect(r.decision).toMatchObject({ kind: 'create', folder: hidden });

    const unknown = emptyRoutes({ 'GET /known-projects': fail(500, 'boom') });
    expect((await refused(go({ sessions: [live], routes: unknown }, { task: 'work on claw today' }, withoutKnown).result)).code).toBe('DENIED');
  });
});

describe('route: the project', () => {
  it('names the project the caller gave, by folder or by name', async () => {
    const sessions = [worker(A, AGENT), worker(B, SITE)];

    const byFolder = await go({ sessions }, { task: 'fix the footer', project: SITE }).result;
    expect(byFolder.project).toMatchObject({ folder: SITE });
    expect(reuseOf(byFolder)).toBe(B);

    const byName = await go({ sessions }, { task: 'fix the footer', project: 'agent manager' }).result;
    expect(byName.project).toMatchObject({ folder: AGENT });
    expect(reuseOf(byName)).toBe(A);
  });

  it('refuses a project it cannot find, rather than routing the task elsewhere', async () => {
    const sessions = [worker(A, AGENT)];

    for (const project of ['no such project', `${HOME}/code/missing`, '/tmp/x', HOME]) {
      const deps = routeDeps({ exists: (p) => !p.includes('missing') });
      const err = await refused(go({ sessions }, { project }, deps).result);
      expect(err.code, project).toBe('INVALID');
      expect(err.message, project).not.toContain(project);
    }
  });

  it('no projects is INVALID', async () => {
    const err = await refused(go({ sessions: [], routes: emptyRoutes() }, { task: 'do something useful' }).result);

    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/which project/);
    expect(err.hint).toMatch(/Name the project or a session/);
  });

  it('a task with no evidence goes to the most recently active folder, marked low', async () => {
    const sessions = [worker(A, AGENT, { lastActivityAt: NOW - 30 * MIN }), worker(B, SITE, { lastActivityAt: NOW - 2 * MIN })];

    const r = await go({ sessions }, { task: 'tidy up the backlog' }).result;

    expect(r.confidence).toBe('low');
    expect(r.project).toMatchObject({ folder: SITE });
    expect(reuseOf(r)).toBe(B);
  });

  it('a blank task is INVALID', async () => {
    expect((await refused(go({ sessions: [worker(A, AGENT)] }, { task: '   ' }).result)).code).toBe('INVALID');
  });

  it('a project central’s route never leaves its folder', async () => {
    const central = makeCentral('project', AGENT, { centralId: 'proj-1' });
    const sessions = [worker(A, AGENT), worker(B, SITE, { ...withContext(10), lastActivityAt: NOW - MIN, title: 'flaky queue test' })];

    const stays = await go({ central, sessions }, { task: 'fix the site footer' }).result;
    expect(stays.project).toMatchObject({ folder: AGENT });
    expect(stays.confidence).toBe('high');
    expect(reuseOf(stays)).toBe(A);

    for (const project of [SITE, `${HOME}/code`]) {
      const err = await refused(go({ central, sessions }, { project }).result);
      expect(err.code, project).toBe('NOT_IN_SCOPE');
      expect(err.message, project).not.toContain(project);
    }
    // A name it cannot see is simply not a project it knows.
    expect((await refused(go({ central, sessions }, { project: 'site' }).result)).code).toBe('INVALID');

    const fresh = await go({ central, sessions: [worker(B, SITE)] }).result;
    expect(fresh.decision).toMatchObject({ kind: 'create', folder: AGENT });
  });

  it('a room central reuses only the room’s sessions and files new ones into the room', async () => {
    const central = makeCentral('room', 'r1', { centralId: 'room-1' });
    const mine = worker(A, AGENT);
    const notMine = worker(B, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN });
    const rooms = [makeRoom('r1', [A]), makeRoom('r2', [B])];

    const r = await go({ central, sessions: [mine, notMine], rooms }).result;

    expect(reuseOf(r)).toBe(A);
    expect(idsOf(r.runnersUp)).toEqual([]);
  });
});

describe('route: handoff', () => {
  const projectChild = childCentral('project', AGENT, 'proj-1');
  const roomChild = childCentral('room', 'r1', 'room-1');
  const inRoom = worker(A, AGENT, { status: 'working' });
  const rooms = [makeRoom('r1', [A])];

  const world = (kids: Array<ReturnType<typeof childCentral>>, extra: Session[] = [inRoom]): CtxOptions => ({
    central: GLOBAL,
    centrals: [GLOBAL, ...kids.map((k) => k.record)],
    sessions: [...extra, ...kids.map((k) => k.card)],
    rooms,
  });

  it('global hands off to the project central that owns the folder', async () => {
    const r = await go(world([projectChild])).result;

    expect(r.decision).toMatchObject({ kind: 'handoff', centralId: 'proj-1' });
    expect(r.decision.reasons.join(' ')).toMatch(/project central/);
    expect(r.runnersUp).toEqual([]);
    expect(r.project).toMatchObject({ folder: AGENT });
    expect(explain(r)).toMatch(/^hands off to central #proj-1: /);
  });

  it('global prefers a project central over a room central', async () => {
    const both = await go(world([roomChild, projectChild])).result;
    expect(both.decision).toMatchObject({ kind: 'handoff', centralId: 'proj-1' });

    const roomOnly = await go(world([roomChild])).result;
    expect(roomOnly.decision).toMatchObject({ kind: 'handoff', centralId: 'room-1' });
    expect(roomOnly.decision.reasons.join(' ')).toMatch(/room central/);
  });

  it('the project central whose folder is the closest above the project wins', async () => {
    const wide = childCentral('project', `${HOME}/code`, 'proj-wide');

    const r = await go(world([wide, projectChild])).result;

    expect(r.decision).toMatchObject({ kind: 'handoff', centralId: 'proj-1' });
  });

  it('a project central of another folder, or a room that is not the project’s room, owns nothing', async () => {
    const elsewhere = childCentral('project', SITE, 'proj-site');
    const otherRoom = childCentral('room', 'r9', 'room-9');

    const r = await go(world([elsewhere, otherRoom], [worker(B, AGENT)])).result;

    expect(r.decision).toMatchObject({ kind: 'reuse', sessionId: B });
  });

  it('a central that is gone is not handed to', async () => {
    const dead = childCentral('project', AGENT, 'proj-1', { status: 'ended' });
    const noTerminal = childCentral('room', 'r1', 'room-1', { terminalId: null });

    const r = await go(world([dead, noTerminal])).result;

    expect(r.decision.kind).not.toBe('handoff');
  });

  it('a room central never hands off', async () => {
    const central = makeCentral('room', 'r1', { centralId: 'room-9' });
    const opts = { ...world([projectChild, roomChild]), central, centrals: [central, projectChild.record, roomChild.record] };

    const r = await go(opts).result;

    expect(r.decision.kind).not.toBe('handoff');
  });

  it('a project central never hands off', async () => {
    const central = makeCentral('project', AGENT, { centralId: 'proj-9' });
    const nested = childCentral('project', `${AGENT}/packages/web`, 'proj-web');
    const opts = { ...world([nested]), central, centrals: [central, nested.record] };

    const r = await go(opts).result;

    expect(r.decision.kind).not.toBe('handoff');
  });

  it('a task that must open a new session, or replaces a failed one, is not handed off', async () => {
    const fresh = await go(world([projectChild]), { newOnly: true }).result;
    expect(fresh.decision.kind).toBe('create');

    const retry = await go(world([projectChild]), { exclude: [A] }).result;
    expect(retry.decision.kind).not.toBe('handoff');
  });
});
