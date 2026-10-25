// test/mcp/projectIndex.test.ts — what AASC knows about project folders (server/mcp/projectIndex.ts): the union of live
// cards, the Library scan (GET /resources) and the history DB (GET /db/projects), cut to the calling central's scope,
// and a folder's profile (the CLI, model, effort and room its latest session used). Everything goes through the fake
// /api client; nothing reads the disk, and the home folder is passed in.
import { describe, expect, it, vi } from 'vitest';
import { listProjects, profileOf, type KnownProject } from '../../server/mcp/projectIndex.js';
import { deepFreeze } from './readFixtures.js';
import { envelope, fail, makeCentral, makeCtx, makeRoom, makeSession, NOW, ok } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const HOME = '/home/tester';
const ALPHA = `${HOME}/code/alpha`;
const BETA = `${HOME}/code/beta`;
const MIN = 60_000;

const card = (id: string, projectPath: string, over: Parameters<typeof makeSession>[1] = {}) =>
  makeSession(id, { projectPath, terminalId: `t-${id}`, cliSource: 'claude', lastActivityAt: NOW - 10 * MIN, ...over });

const resourceProject = (path: string, over: Record<string, unknown> = {}) => ({
  id: `p-${path}`, name: path.split('/').pop(), path, exists: true, evidence: ['claude-projects'], counts: {}, ...over,
});
const resources = (projects: unknown[], state = 'ready') => envelope({ state, projects, resources: [], findings: [], coverage: [] });
const history = (...paths: string[]) => ok(paths.map((p) => ({ project_path: p, project_name: p.split('/').pop() })));

describe('listProjects', () => {
  it('live, discovered and history merge by folder', async () => {
    const sessions = [
      card('s1', ALPHA, { lastActivityAt: NOW - 20 * MIN }),
      card('s2', `${ALPHA}/`, { lastActivityAt: NOW - 5 * MIN }),
      card('s3', BETA, { lastActivityAt: NOW - 60 * MIN }),
    ];
    const { ctx } = makeCtx({
      sessions,
      rooms: [makeRoom('r1', ['s1']), makeRoom('r2', ['s3', 's2'])],
      routes: {
        'GET /resources': resources([resourceProject('~/code/alpha'), resourceProject('~/code/gamma')]),
        'GET /db/projects': history(ALPHA, `${HOME}/code/delta`),
      },
    });

    const got = await listProjects(ctx, { home: HOME });

    expect(got).toEqual<KnownProject[]>([
      { folder: ALPHA, name: 'alpha', sources: ['live', 'discovered', 'history'], lastActiveAt: NOW - 5 * MIN, roomIds: ['r1', 'r2'] },
      { folder: BETA, name: 'beta', sources: ['live'], lastActiveAt: NOW - 60 * MIN, roomIds: ['r2'] },
      { folder: `${HOME}/code/delta`, name: 'delta', sources: ['history'], lastActiveAt: null, roomIds: [] },
      { folder: `${HOME}/code/gamma`, name: 'gamma', sources: ['discovered'], lastActiveAt: null, roomIds: [] },
    ]);
  });

  it('asks the three sources the plan names, and nothing else', async () => {
    const { ctx, client } = makeCtx({
      sessions: [card('s1', ALPHA)],
      routes: { 'GET /resources': resources([]), 'GET /db/projects': history() },
    });

    await listProjects(ctx, { home: HOME });

    expect(client.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(['GET /db/projects', 'GET /resources']);
  });

  it('scanning resources are skipped, not an error', async () => {
    const scanning = makeCtx({
      sessions: [card('s1', ALPHA)],
      routes: {
        'GET /resources': resources([resourceProject('~/code/ghost')], 'scanning'),
        'GET /db/projects': history(BETA),
      },
    });
    const got = await listProjects(scanning.ctx, { home: HOME });
    expect(got.map((p) => p.folder)).toEqual([ALPHA, BETA]);

    // A 404 (the route answers a non-local caller so), a server error and a call that never arrived are skipped too.
    for (const answer of [fail(404, 'Not found'), fail(500, 'boom'), { ok: false, status: 0, data: null, error: 'fetch failed' }]) {
      const { ctx } = makeCtx({ sessions: [card('s1', ALPHA)], routes: { 'GET /resources': answer, 'GET /db/projects': history(BETA) } });
      expect((await listProjects(ctx, { home: HOME })).map((p) => p.folder)).toEqual([ALPHA, BETA]);
    }
  });

  it('a history DB that answers nothing readable leaves the other sources whole', async () => {
    for (const answer of [fail(500, 'boom'), ok(null), ok({ not: 'a list' }), ok([null, 7, 'x', { project_path: 5 }, { project_name: 'no path' }])]) {
      const { ctx } = makeCtx({ sessions: [card('s1', ALPHA)], routes: { 'GET /resources': resources([resourceProject('~/code/gamma')]), 'GET /db/projects': answer } });
      expect((await listProjects(ctx, { home: HOME })).map((p) => p.folder)).toEqual([ALPHA, `${HOME}/code/gamma`]);
    }
  });

  it('a project central sees only its folder and below', async () => {
    const { ctx } = makeCtx({
      central: makeCentral('project', ALPHA),
      sessions: [card('s1', ALPHA), card('s2', `${ALPHA}/packages/web`), card('s3', BETA), card('s4', `${ALPHA}2`)],
      routes: {
        'GET /resources': resources([resourceProject('~/code/alpha'), resourceProject('~/code/beta'), resourceProject('~/code/alpha2')]),
        'GET /db/projects': history(`${ALPHA}/docs`, BETA, `${HOME}/code`),
      },
    });

    const got = await listProjects(ctx, { home: HOME });

    expect(got.map((p) => p.folder).sort()).toEqual([ALPHA, `${ALPHA}/docs`, `${ALPHA}/packages/web`]);
  });

  it('a room central sees every project, its own room’s marked', async () => {
    const { ctx } = makeCtx({
      central: makeCentral('room', 'r1'),
      sessions: [card('s1', ALPHA), card('s2', BETA)],
      rooms: [makeRoom('r1', ['s1']), makeRoom('r2', ['s2'])],
      routes: { 'GET /resources': resources([]), 'GET /db/projects': history(`${HOME}/code/gamma`) },
    });

    const got = await listProjects(ctx, { home: HOME });

    expect(got.map((p) => p.folder).sort()).toEqual([ALPHA, BETA, `${HOME}/code/gamma`]);
    expect(got.find((p) => p.folder === ALPHA)?.roomIds).toEqual(['r1']);
    expect(got.find((p) => p.folder === BETA)?.roomIds).toEqual(['r2']);
    expect(got.find((p) => p.folder === `${HOME}/code/gamma`)?.roomIds).toEqual([]);
  });

  it('home and its ancestors never appear', async () => {
    const { ctx } = makeCtx({
      sessions: [card('s1', HOME), card('s2', `${HOME}/`), card('s3', '/home'), card('s4', '/'), card('s5', ALPHA)],
      routes: {
        'GET /resources': resources([resourceProject('~', { isHome: true }), resourceProject('~/code/beta'), resourceProject('/home')]),
        'GET /db/projects': history(HOME, '/', '/home', `${HOME}/code/gamma`),
      },
    });

    const got = await listProjects(ctx, { home: HOME });

    expect(got.map((p) => p.folder).sort()).toEqual([ALPHA, BETA, `${HOME}/code/gamma`]);
  });

  it('a card that is not a project’s own work is not a live project: floating, external, SSH, a central, no folder', async () => {
    const { ctx } = makeCtx({
      sessions: [
        card('real', ALPHA, { lastActivityAt: NOW - 30 * MIN }),
        card('float', `${HOME}/code/float`, { isFloating: true }),
        card('ext', `${HOME}/code/ext`, { isExternal: true }),
        card('ssh', `${HOME}/code/remote`, { sshHost: 'build-box' }),
        card('cen', `${HOME}/code/central`, { central: { centralId: 'c9', kind: 'global', scopeRef: null }, lastActivityAt: NOW }),
        card('blank', '   '),
      ],
      routes: { 'GET /resources': resources([]), 'GET /db/projects': history() },
    });

    const got = await listProjects(ctx, { home: HOME });

    expect(got).toEqual([{ folder: ALPHA, name: 'alpha', sources: ['live'], lastActiveAt: NOW - 30 * MIN, roomIds: [] }]);
  });

  it('a discovered project that is gone, or only a linked worktree of another, is left out', async () => {
    const { ctx } = makeCtx({
      routes: {
        'GET /resources': resources([
          resourceProject('~/code/alpha'),
          resourceProject('~/code/gone', { exists: false }),
          resourceProject('~/code/alpha-wt', { worktreeOf: '~/code/alpha' }),
          { id: 'x', path: 7 },
          null,
          'junk',
        ]),
        'GET /db/projects': history(),
      },
    });

    const got = await listProjects(ctx, { home: HOME });

    expect(got.map((p) => p.folder)).toEqual([ALPHA]);
  });

  it('is the live cards alone when the routes are down, and changes nothing it is given', async () => {
    const sessions = deepFreeze([card('s1', ALPHA)]);
    const rooms = deepFreeze([makeRoom('r1', ['s1'])]);
    const { ctx } = makeCtx({ sessions, rooms });

    const got = await listProjects(ctx, { home: HOME });

    expect(got.map((p) => p.folder)).toEqual([ALPHA]);
    expect(got[0].roomIds).toEqual(['r1']);
  });
});

describe('profileOf', () => {
  it('profile prefers the newest live card', async () => {
    const sessions = [
      card('old', ALPHA, { cliSource: 'codex', model: 'gpt-5.1-codex', effortLevel: 'low', lastActivityAt: NOW - 50 * MIN }),
      card('new', ALPHA, {
        cliSource: 'claude', model: 'claude-sonnet-5-5', effortLevel: 'medium',
        runtime: { model: 'claude-opus-5-5', effort: 'high' }, lastActivityAt: NOW - 2 * MIN,
      }),
      card('elsewhere', BETA, { cliSource: 'codex', lastActivityAt: NOW }),
    ];
    const { ctx, client } = makeCtx({ sessions, rooms: [makeRoom('r1', ['new', 'old'])] });

    const got = await profileOf(ctx, ALPHA);

    expect(got).toEqual({ folder: ALPHA, cli: 'claude', model: 'claude-opus-5-5', effort: 'high', roomId: 'r1', from: 'live' });
    expect(client.calls).toEqual([]);
  });

  it('falls back to the launch model and effort when the card reports no runtime', async () => {
    const { ctx } = makeCtx({ sessions: [card('s1', ALPHA, { model: 'claude-opus-5-5', effortLevel: 'xhigh' })] });

    expect(await profileOf(ctx, ALPHA)).toEqual({ folder: ALPHA, cli: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', roomId: null, from: 'live' });
  });

  it('answers with the room most of the folder’s sessions sit in, the newest card’s on a tie', async () => {
    const sessions = [
      card('a', ALPHA, { lastActivityAt: NOW - 30 * MIN }),
      card('b', ALPHA, { lastActivityAt: NOW - 20 * MIN }),
      card('c', ALPHA, { lastActivityAt: NOW - 1 * MIN }),
    ];
    const rooms = [makeRoom('r1', ['a', 'b']), makeRoom('r2', ['c'])];
    expect((await profileOf(makeCtx({ sessions, rooms }).ctx, ALPHA)).roomId).toBe('r1');

    const tie = [card('a', ALPHA, { lastActivityAt: NOW - 30 * MIN }), card('c', ALPHA, { lastActivityAt: NOW - 1 * MIN })];
    expect((await profileOf(makeCtx({ sessions: tie, rooms: [makeRoom('r1', ['a']), makeRoom('r2', ['c'])] }).ctx, ALPHA)).roomId).toBe('r2');
  });

  it('counts a card that has ended, and the folder in any spelling', async () => {
    const { ctx } = makeCtx({ sessions: [card('gone', ALPHA, { status: 'ended', endedAt: NOW - MIN, cliSource: 'codex', model: 'gpt-5.1-codex' })] });

    expect(await profileOf(ctx, `${ALPHA}/`)).toMatchObject({ cli: 'codex', model: 'gpt-5.1-codex', from: 'live' });
  });

  it('is not given by a card that is a central, floating, external, on another machine or of an unknown CLI', async () => {
    const sessions = [
      card('cen', ALPHA, { central: { centralId: 'c1', kind: 'project', scopeRef: ALPHA }, model: 'central-model' }),
      card('float', ALPHA, { isFloating: true }),
      card('ext', ALPHA, { isExternal: true }),
      card('ssh', ALPHA, { sshHost: 'build-box' }),
      card('gem', ALPHA, { cliSource: 'gemini' }),
    ];
    const { ctx } = makeCtx({ sessions, routes: { 'GET /db/sessions': ok({ sessions: [], total: 0, page: 1, pageSize: 1 }) } });

    expect((await profileOf(ctx, ALPHA)).from).toBe('none');
  });

  it('profile falls back to history then none', async () => {
    const row = { id: 'h1', project_path: ALPHA, model: 'gpt-5.1-codex', last_activity_at: NOW - 3_000 };
    const withRow = makeCtx({ routes: { 'GET /db/sessions': ok({ sessions: [row], total: 4, page: 1, pageSize: 1 }) } });

    expect(await profileOf(withRow.ctx, ALPHA)).toEqual({ folder: ALPHA, cli: 'codex', model: 'gpt-5.1-codex', effort: null, roomId: null, from: 'history' });
    expect(withRow.client.calls).toEqual([
      { method: 'GET', path: '/db/sessions', query: { project: ALPHA, sortBy: 'last_activity_at', sortDir: 'desc', pageSize: 1, archived: 'all' } },
    ]);

    const empty = makeCtx({ routes: { 'GET /db/sessions': ok({ sessions: [], total: 0, page: 1, pageSize: 1 }) } });
    expect(await profileOf(empty.ctx, ALPHA)).toEqual({ folder: ALPHA, cli: null, model: null, effort: null, roomId: null, from: 'none' });

    for (const answer of [fail(500, 'boom'), fail(404, 'Not found'), ok(null), ok({ sessions: 'nope' }), ok({ sessions: [7, null] })]) {
      const { ctx } = makeCtx({ routes: { 'GET /db/sessions': answer } });
      expect((await profileOf(ctx, ALPHA)).from).toBe('none');
    }
  });

  it('reads a history row with no model as a folder it knows nothing of', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /db/sessions': ok({ sessions: [{ id: 'h1', model: '' }] }) } });

    expect(await profileOf(ctx, ALPHA)).toEqual({ folder: ALPHA, cli: null, model: null, effort: null, roomId: null, from: 'history' });
  });
});
