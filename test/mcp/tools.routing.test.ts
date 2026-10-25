// test/mcp/tools.routing.test.ts — the two read tools of P4's routing (server/mcp/tools/routing.ts): project_resolve
// (which project a task is about) and task_route (where task_delegate to "auto" would send it, as a dry run). Both
// read and decide; neither opens a session nor types anything, and both work whatever `mcp.autoRouting` says
// (Ruling P4-15). What a central must act on (the confidence, the ask to name the project) is in `data` (Ruling 66).
// The router's real dependencies (workerDeps.ts) are replaced with ones that never touch the disk.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../server/serverConfig.js';
import { allTools } from '../../server/mcp/registry.js';
import { A, AGENT, B, MIN, ROUTES, routeDeps, SITE, TASK, worker, withContext } from './routerFixtures.js';
import { dataOf, makeCentral, makeCtx, NOW, run, runRefused, type CtxOptions } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));
// The factory may not import the fixtures: they reach this module through the registry (an import cycle).
const seam = vi.hoisted(() => ({ route: {} as Record<string, unknown> }));
vi.mock('../../server/mcp/workerDeps.js', () => ({
  routeDepsFor: () => seam.route,
  openWorkerDepsFor: () => {
    throw new Error('a routing read never opens a session');
  },
  knownRootsOf: async () => [],
  planWindowPct: () => null,
}));
seam.route = { ...routeDeps() };

interface ResolveData {
  projects: Array<{ folder: string; name: string; score: number; why: string }>;
  confidence: string;
  lowConfidence: boolean;
  advice: string | null;
}
interface RouteData {
  decision: { kind: string; sessionId?: string; folder?: string; reasons: string[] };
  runnersUp: Array<{ sessionId: string; skipped?: string }>;
  confidence: string;
  project: { folder: string; source: string } | null;
  explanation: string;
  lowConfidence: boolean;
  advice: string | null;
}

const ctxWith = (opts: CtxOptions) => makeCtx({ routes: ROUTES, ...opts });

const original = config.mcp;
afterEach(() => {
  if (original === undefined) delete config.mcp;
  else config.mcp = original;
});

describe('project_resolve', () => {
  it('ranks the projects a task is about, top 5, with how sure it is', async () => {
    const h = ctxWith({ sessions: [worker(A, AGENT), worker(B, SITE)] });

    const data = await dataOf<ResolveData>('project_resolve', { task: TASK }, h.ctx);

    expect(data.projects[0]).toMatchObject({ folder: AGENT, name: 'agent-manager', why: expect.any(String) });
    expect(data.projects.length).toBeLessThanOrEqual(5);
    expect(data.projects.map((p) => p.folder)).toContain(SITE);
    expect(data.confidence).toBe('high');
    expect(data.lowConfidence).toBe(false);
    expect(data.advice).toBeNull();
  });

  it('takes a folder or a name as a hint', async () => {
    const h = ctxWith({ sessions: [worker(A, AGENT), worker(B, SITE)] });

    const byName = await dataOf<ResolveData>('project_resolve', { task: 'tidy up the backlog', name: 'site' }, h.ctx);
    const byFolder = await dataOf<ResolveData>('project_resolve', { task: 'tidy up the backlog', folder: SITE }, h.ctx);

    expect(byName.projects[0].folder).toBe(SITE);
    expect(byFolder.projects[0].folder).toBe(SITE);
  });

  it('asks, in data, for the project to be named when it only guessed', async () => {
    const h = ctxWith({ sessions: [worker(A, AGENT, { lastActivityAt: NOW - MIN })] });

    const result = await run('project_resolve', { task: 'tidy up the backlog' }, h.ctx);
    const data = result.data as ResolveData;

    expect(data.confidence).toBe('low');
    expect(data.lowConfidence).toBe(true);
    expect(data.advice).toMatch(/name the project/i);
  });

  it('never calls anything but a read', async () => {
    const h = ctxWith({ sessions: [worker(A, AGENT)] });

    await run('project_resolve', { task: TASK }, h.ctx);

    expect(h.client.calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

describe('task_route', () => {
  it('answers where "auto" would send a task: the decision, the runners-up, the project and why', async () => {
    const best = worker(A, AGENT, { ...withContext(23), lastActivityAt: NOW - 10 * MIN });
    const h = ctxWith({ sessions: [best, worker(B, AGENT)] });

    const result = await run('task_route', { task: TASK }, h.ctx);
    const data = result.data as RouteData;

    expect(data.decision).toMatchObject({ kind: 'reuse', sessionId: A });
    expect(data.runnersUp.map((c) => c.sessionId)).toEqual([B]);
    expect(data.project).toMatchObject({ folder: AGENT });
    expect(data.explanation).toMatch(/^routed to #sess-aaa: same folder, idle/);
    expect(result.summary).toContain(data.explanation);
  });

  it("task_route's confidence and its ask to name the project are in data", async () => {
    const h = ctxWith({ sessions: [worker(A, AGENT, { status: 'working', lastActivityAt: NOW - MIN })] });

    const data = await dataOf<RouteData>('task_route', { task: 'tidy up the backlog' }, h.ctx);

    expect(data.confidence).toBe('low');
    expect(data.lowConfidence).toBe(true);
    expect(data.advice).toMatch(/name the project/i);
  });

  it('task_route opens nothing and sends nothing', async () => {
    // No session in the project: the decision is a new session, and still nothing is opened.
    const h = ctxWith({ sessions: [] });

    const data = await dataOf<RouteData>('task_route', { task: TASK }, h.ctx);

    expect(data.decision).toMatchObject({ kind: 'create', folder: AGENT });
    expect(h.client.calls.length).toBeGreaterThan(0);
    expect(h.client.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it("a project central's task_route never leaves its folder", async () => {
    const central = makeCentral('project', AGENT);
    const inside = worker(A, AGENT);
    const outside = worker(B, SITE, { ...withContext(5), lastActivityAt: NOW - MIN, title: 'the site' });
    const h = ctxWith({ central, sessions: [inside, outside] });

    const toSite = await dataOf<RouteData>('task_route', { task: 'fix the flaky test on the site' }, h.ctx);
    expect(toSite.project?.folder).toBe(AGENT);
    expect(toSite.decision).toMatchObject({ kind: 'reuse', sessionId: A });
    expect(toSite.runnersUp.map((c) => c.sessionId)).not.toContain(B);

    const empty = ctxWith({ central, sessions: [outside] });
    const created = await dataOf<RouteData>('task_route', { task: TASK }, empty.ctx);
    expect(created.decision).toMatchObject({ kind: 'create', folder: AGENT });

    expect((await runRefused('task_route', { task: TASK, project: SITE }, h.ctx)).code).toBe('NOT_IN_SCOPE');
  });

  it('task_route works with auto routing off', async () => {
    config.mcp = { ...config.mcp, autoRouting: false };
    const h = ctxWith({ sessions: [worker(A, AGENT)] });

    await expect(dataOf<RouteData>('task_route', { task: TASK }, h.ctx)).resolves.toMatchObject({ decision: { kind: 'reuse' } });
    await expect(dataOf<ResolveData>('project_resolve', { task: TASK }, h.ctx)).resolves.toMatchObject({ confidence: 'high' });
  });

  it('refuses a task the router cannot place, and never repeats it', async () => {
    const secret = 'hunter2-the-secret';
    const h = ctxWith({ sessions: [] });

    const err = await runRefused('task_route', { task: `do ${secret}` }, h.ctx);

    expect(err.code).toBe('INVALID');
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain(secret);
  });
});

describe('the routing tools', () => {
  it('are P4 reads of the tasks toolset whose descriptions say auto may be off and low confidence means naming the project', () => {
    const route = allTools().find((t) => t.name === 'task_route')!;
    const resolve = allTools().find((t) => t.name === 'project_resolve')!;

    for (const tool of [route, resolve]) expect(tool).toMatchObject({ toolset: 'tasks', risk: 'read', phase: 4 });
    expect(route.description).toMatch(/opens nothing|dry run/i);
    expect(route.description).toMatch(/auto routing (may be|is) off|whatever .*autoRouting/i);
    expect(route.description).toMatch(/low.*name the project/i);
  });
});
