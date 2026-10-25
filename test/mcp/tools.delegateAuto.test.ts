// test/mcp/tools.delegateAuto.test.ts — task_delegate(to: "auto") (server/mcp/tools/delegateAuto.ts): AASC routes the
// task (router.ts) and carries the decision out — a reuse is a task on the session it picked, a create opens a worker
// of the central's own (openWorker.ts) whose task waits for it to start (Ruling P4-6), a handoff types the task into a
// child central's own card (Ruling P4-8). Off unless `mcp.autoRouting` is true (Ruling P4-10). Every decision is in
// `data` and in the activity row, in AASC's words (Ruling 66). A real ledger on fake deps and fake timers; the router's
// and the opener's real dependencies (workerDeps.ts) are replaced, so nothing reaches a disk, a terminal or a process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { OpenWorkerDeps } from '../../server/mcp/openWorker.js';
import { allTools } from '../../server/mcp/registry.js';
import { config } from '../../server/serverConfig.js';
import { createWorkerRegistry } from '../../server/mcp/workers.js';
import { SteerRefusal } from '../../server/mcp/policy.js';
import { ToolError } from '../../server/mcp/types.js';
import type { ToolContext } from '../../server/mcp/registry.js';
import { deliverCtx } from './deliverToolFixtures.js';
import { A, AGENT, B, GLOBAL, HOME, MIN, ROUTES, TASK, childCentral, routeDeps, worker, withContext } from './routerFixtures.js';
import { makeSession, NOW, ok, run, runRefused, type Answer, type ApiCall } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));
// The factory may not import the fixtures: they reach this module through the registry (an import cycle).
const seam = vi.hoisted(() => ({ route: {} as Record<string, unknown>, open: null as unknown }));
vi.mock('../../server/mcp/workerDeps.js', () => ({
  routeDepsFor: () => seam.route,
  openWorkerDepsFor: () => seam.open,
  knownRootsOf: async () => [],
  planWindowPct: () => null,
}));
seam.route = { ...routeDeps() };

const NEW = 'term-new-1';
const original = config.mcp;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  config.mcp = { ...config.mcp, autoRouting: true };
});
afterEach(() => {
  vi.useRealTimers();
  if (original === undefined) delete config.mcp;
  else config.mcp = original;
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** The global central's card. */
const centralCard = makeSession('card-global', {
  terminalId: GLOBAL.terminalId,
  status: 'waiting',
  permissionMode: 'default',
  central: { centralId: GLOBAL.centralId, kind: 'global', scopeRef: null },
});

interface WorldOptions {
  sessions?: Session[];
  centrals?: Parameters<typeof deliverCtx>[0]['centrals'];
  /** POST /terminals opens the terminal but AASC shows no card for it (default: it shows one). */
  noCard?: boolean;
}

/** The global central over the router's fake home; POST /terminals adds the new connecting card as the route would. */
function world(o: WorldOptions = {}) {
  const workers = createWorkerRegistry({ controller: () => null });
  const holder: { add?: (s: Session) => void } = {};
  const opened: Answer = (call: ApiCall) => {
    const body = call.body as { workingDir: string };
    if (o.noCard !== true) {
      holder.add?.(makeSession(NEW, { terminalId: NEW, status: 'connecting', projectPath: body.workingDir, cliSource: 'claude' }));
    }
    return ok({ ok: true, terminalId: NEW });
  };
  const h = deliverCtx({
    central: GLOBAL,
    sessions: [centralCard, ...(o.sessions ?? [])],
    centrals: o.centrals ?? [GLOBAL],
    workers,
    routes: {
      ...ROUTES,
      'POST /terminals': opened,
      [`DELETE /sessions/${NEW}`]: ok({ ok: true, removed: true }),
      [`DELETE /terminals/${NEW}`]: ok({ ok: true }),
    },
  });
  holder.add = (s) => {
    h.sessions.push(s);
    h.f.setSession(s);
  };
  const deps: OpenWorkerDeps = { knownProjects: async () => [AGENT], home: HOME, realpath: async (p) => p, planWindowPct: () => null, now: () => NOW, workers };
  seam.open = deps;
  const posts = (path: string) => h.client.calls.filter((c) => c.method === 'POST' && c.path === path);
  const deletes = () => h.client.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
  return { ...h, workers, posts, deletes };
}

interface AutoData {
  requested: number;
  started: number;
  tasks: Array<{ taskId: string | null; sessionId: string | null; state: string | null }>;
  route: {
    decision: { kind: string; sessionId?: string; centralId?: string; folder?: string; reasons: string[] };
    confidence: string;
    project: { folder: string; source: string } | null;
    runnersUp: Array<{ sessionId: string }>;
    explanation: string;
    lowConfidence: boolean;
    advice: string | null;
  };
}

describe('task_delegate to "auto"', () => {
  it('auto reuses the best idle session', async () => {
    const best = worker(A, AGENT, { ...withContext(23), lastActivityAt: NOW - 10 * MIN });
    const w = world({ sessions: [best, worker(B, AGENT)] });

    const result = await run('task_delegate', { to: 'auto', task: TASK }, w.ctx);
    await flush();

    const data = result.data as AutoData;
    expect(data).toMatchObject({ requested: 1, started: 1, tasks: [{ taskId: 'T1', sessionId: A, state: 'queued' }] });
    expect(data.route).toMatchObject({ decision: { kind: 'reuse', sessionId: A }, confidence: 'high', project: { folder: AGENT } });
    expect(data.route.runnersUp.map((c) => c.sessionId)).toEqual([B]);
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([A]);
    expect(w.base.get('T1')?.route).toEqual({ by: 'auto', decision: 'reuse', reasons: ['same folder', 'idle', 'ctx 23 %', 'active 10m ago'] });
    expect(w.posts('/terminals')).toEqual([]);
    // The activity row explains the decision in AASC's words and ids: the reasons and the runner-up.
    expect(result.activity).toEqual([
      expect.objectContaining({
        summary: 'routed to #sess-aaa: same folder, idle, ctx 23 %, active 10m ago; runner-up #sess-bbb scored 5',
        targetSessionId: A,
        taskId: 'T1',
        detail: expect.objectContaining({ decision: 'reuse', confidence: 'high' }),
      }),
    ]);
    expect(result.summary).toMatch(/T1/);
    expect(result.summary).toMatch(/task_wait/);
  });

  it('auto opens a worker and the task waits for it', async () => {
    const w = world({ sessions: [worker(A, AGENT, { status: 'working' })] });

    const result = await run('task_delegate', { to: 'auto', task: TASK }, w.ctx);
    await flush();

    const data = result.data as AutoData;
    expect(data.route.decision).toMatchObject({ kind: 'create', folder: AGENT });
    expect(data.tasks[0]).toMatchObject({ taskId: 'T1', sessionId: NEW, state: 'queued' });
    expect(w.posts('/terminals')[0].body).toMatchObject({ forceNew: true, workingDir: AGENT, command: 'claude' });
    expect(w.workers.of(GLOBAL.centralId).map((x) => x.terminalId)).toEqual([NEW]);
    // Nothing is typed into a session still starting; its SessionStart sends the task.
    expect(w.f.submits).toEqual([]);
    w.f.hook('SessionStart', NEW, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(10);
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([NEW]);
    expect(w.base.get('T1')?.route?.decision).toBe('create');
    expect(result.activity?.map((n) => n.summary)).toEqual([
      'opened a claude session of its own',
      expect.stringMatching(/^opens a new session: every session in the project is busy or unavailable/),
    ]);
  });

  it('auto hands off to the child central', async () => {
    const child = childCentral('project', AGENT, 'proj-central');
    const w = world({ sessions: [child.card, worker(A, AGENT)], centrals: [GLOBAL, child.record] });

    const result = await run('task_delegate', { to: 'auto', task: TASK }, w.ctx);
    await flush();

    const data = result.data as AutoData;
    expect(data.route.decision).toMatchObject({ kind: 'handoff', centralId: 'proj-central' });
    expect(data.tasks[0]).toMatchObject({ taskId: 'T1', sessionId: child.card.sessionId });
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([child.card.sessionId]);
    expect(w.f.submits[0].text).toMatch(/^\[AASC · task T1 from ★ global\]/);
    expect(w.base.get('T1')?.route?.decision).toBe('handoff');
  });

  it('a hand-off is held to the rails: a hands-off child central is passed over, never typed into (Ruling P4-27)', async () => {
    const child = childCentral('project', AGENT, 'proj-central', { handsOff: true });
    const w = world({ sessions: [child.card, worker(A, AGENT)], centrals: [GLOBAL, child.record] });

    const data = (await run('task_delegate', { to: 'auto', task: TASK }, w.ctx)).data as AutoData;
    await flush();

    expect(data.route.decision).toMatchObject({ kind: 'reuse', sessionId: A });
    expect(data.route.decision.reasons).toContain('central #proj-cen passed over (HANDS_OFF)');
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([A]);
  });

  it('task_route and auto agree when the child refuses', async () => {
    const child = childCentral('project', AGENT, 'proj-central', { handsOff: true });
    const w = world({ sessions: [child.card, worker(A, AGENT)], centrals: [GLOBAL, child.record] });

    const dry = (await run('task_route', { task: TASK }, w.ctx)).data as AutoData['route'];
    const auto = (await run('task_delegate', { to: 'auto', task: TASK }, w.ctx)).data as AutoData;
    await flush();

    expect(dry.decision).toEqual(auto.route.decision);
    expect(dry.decision).toMatchObject({ kind: 'reuse', sessionId: A });
  });

  it('a create says in data the worker it opened: its terminal, and whether its room has it', async () => {
    const w = world({ sessions: [worker(A, AGENT, { status: 'working' })] });

    const data = (await run('task_delegate', { to: 'auto', task: TASK }, w.ctx)).data as AutoData & {
      opened: { terminalId: string; filed: boolean; note: string | null } | null;
    };

    expect(data.opened).toEqual(expect.objectContaining({ terminalId: NEW, filed: expect.any(Boolean), note: null }));
    const reuse = world({ sessions: [worker(A, AGENT)] });
    expect(((await run('task_delegate', { to: 'auto', task: TASK }, reuse.ctx)).data as { opened: unknown }).opened).toBeNull();
  });

  it('a create that throws after the worker opened closes that worker', async () => {
    const w = world({ sessions: [worker(A, AGENT, { status: 'working' })] });
    const busy = new ToolError('BUSY', 'Another central gave that session a task meanwhile.', 'Call task_delegate again.');
    const ledger = new Proxy(w.ctx.ledger, {
      get: (target, key) => (key === 'create' ? () => { throw busy; } : Reflect.get(target, key)),
    });
    const ctx: ToolContext = { ...w.ctx, ledger };

    const err = await runRefused('task_delegate', { to: 'auto', task: TASK }, ctx);
    await flush();

    expect(err.code).toBe('BUSY');
    // The refusal names the worker: its row is about that session, and its words say AASC closed it.
    expect(err).toBeInstanceOf(SteerRefusal);
    expect((err as SteerRefusal).sessionId).toBe(NEW);
    expect(err.message).toMatch(/closed the session it opened for it \(#term-new\)/);
    expect(w.posts('/terminals')).toHaveLength(1);
    expect(w.deletes()).toEqual([`/sessions/${NEW}`]);
    expect(w.f.submits).toEqual([]);
  });

  it('a worker whose card AASC does not show is closed by its terminal', async () => {
    const w = world({ sessions: [worker(A, AGENT, { status: 'working' })], noCard: true });

    const err = await runRefused('task_delegate', { to: 'auto', task: TASK }, w.ctx);

    expect(err.code).toBe('UPSTREAM');
    expect(err.message).toMatch(/closed the session it opened for it/);
    expect(w.deletes()).toEqual([`/terminals/${NEW}`]);
  });

  it('"auto" mixed with ids is INVALID', async () => {
    const w = world({ sessions: [worker(A, AGENT)] });

    for (const to of [[A, 'auto'], ['auto', 'auto'], [' AUTO ', A]]) {
      const err = await runRefused('task_delegate', { to, task: TASK }, w.ctx);
      expect(err.code, JSON.stringify(to)).toBe('INVALID');
      expect(err.message).toMatch(/only target|alone/);
    }
    // The route's own options are for "auto" only.
    expect((await runRefused('task_delegate', { to: A, task: TASK, newOnly: true }, w.ctx)).code).toBe('INVALID');
    await flush();
    expect(w.f.submits).toEqual([]);
  });

  it('autoRouting off is UNAVAILABLE', async () => {
    config.mcp = { ...config.mcp, autoRouting: false };
    const w = world({ sessions: [worker(A, AGENT)] });

    const err = await runRefused('task_delegate', { to: 'auto', task: TASK }, w.ctx);

    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toBe('auto routing is off in this AASC');
    expect(err.hint).toMatch(/mcp\.autoRouting.*true.*server-config\.json.*restart AASC/);
    await flush();
    expect(w.f.submits).toEqual([]);
    expect(w.client.calls).toEqual([]);
  });

  it('says in data when it only guessed the project, and asks for it to be named', async () => {
    const w = world({ sessions: [worker(A, AGENT, { lastActivityAt: NOW - MIN })] });

    const data = (await run('task_delegate', { to: 'auto', task: 'tidy up the backlog' }, w.ctx)).data as AutoData;

    expect(data.route.confidence).toBe('low');
    expect(data.route.lowConfidence).toBe(true);
    expect(data.route.advice).toMatch(/name the project/i);
  });

  it('passes the route its options: newOnly opens a new session though one is idle', async () => {
    const w = world({ sessions: [worker(A, AGENT, withContext(5))] });

    const data = (await run('task_delegate', { to: 'auto', task: TASK, newOnly: true }, w.ctx)).data as AutoData;

    expect(data.route.decision).toMatchObject({ kind: 'create', reasons: expect.arrayContaining(['a new session was asked for']) });
    expect(w.posts('/terminals')).toHaveLength(1);
  });

  it('never repeats the task in a refusal', async () => {
    const secret = 'hunter2-the-secret';
    const w = world({ sessions: [] });

    const err = await runRefused('task_delegate', { to: 'auto', task: `do ${secret}` }, w.ctx);

    expect(err.code).toBe('INVALID');
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain(secret);
  });
});

describe('the descriptions (Ruling 65)', () => {
  it('task_delegate and prompt_send say never to ask a session to approve for the person', () => {
    for (const name of ['task_delegate', 'prompt_send']) {
      const description = allTools().find((t) => t.name === name)!.description;
      expect(description, name).toMatch(/never ask a session to approve/i);
      expect(description, name).toMatch(/request_list/);
    }
  });

  it('task_delegate says auto routing may be off and that low confidence means naming the project', () => {
    const description = allTools().find((t) => t.name === 'task_delegate')!.description;

    expect(description).toMatch(/"auto"/);
    expect(description).toMatch(/auto routing (may be|is) off/i);
    expect(description).toMatch(/low.*name the project/i);
  });
});
