// test/mcp/rerouter.test.ts — the re-router (server/mcp/rerouter.ts): a task AASC routed itself (task_delegate to
// "auto") whose worker's terminal closed before its turn stopped is routed again, once, as its central, leaving the
// failed session out, and re-targeted under the same task id (Ruling P4-7). A second death stays failed; a cancelled
// task, a refusal or an answer is never re-routed. Both the decision and its failure are logged. A real ledger on fake
// deps and fake timers; the router's and the opener's dependencies are replaced, so nothing reaches a disk or a process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { ActivityInput } from '../../server/mcp/activity.js';
import type { OpenWorkerDeps } from '../../server/mcp/openWorker.js';
import { startRerouter } from '../../server/mcp/rerouter.js';
import { config } from '../../server/serverConfig.js';
import { createWorkerRegistry } from '../../server/mcp/workers.js';
import { deliverCtx } from './deliverToolFixtures.js';
import { A, AGENT, B, GLOBAL, HOME, MIN, ROUTES, TASK, routeDeps, worker, withContext } from './routerFixtures.js';
import { ToolError } from '../../server/mcp/types.js';
import { makeSession, NOW, ok, run, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));
const seam = vi.hoisted(() => ({ route: {} as Record<string, unknown>, open: null as unknown }));
vi.mock('../../server/mcp/workerDeps.js', () => ({
  routeDepsFor: () => seam.route,
  openWorkerDepsFor: () => seam.open,
  knownRootsOf: async () => [],
  planWindowPct: () => null,
}));
seam.route = { ...routeDeps() };

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
  await vi.advanceTimersByTimeAsync(10);
};

const centralCard = makeSession('card-global', {
  terminalId: GLOBAL.terminalId,
  status: 'waiting',
  permissionMode: 'default',
  central: { centralId: GLOBAL.centralId, kind: 'global', scopeRef: null },
});

/** The global central with workers A (the better) and B in the project, the re-router running on its ledger. */
function world(
  sessions: Session[] = [worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN }), worker(B, AGENT)],
  routes: Record<string, Answer> = {},
) {
  const workers = createWorkerRegistry({ controller: () => null });
  const holder: { add?: (s: Session) => void } = {};
  let opened = 0;
  const open: Answer = () => {
    opened += 1;
    const id = `term-new-${opened}`;
    holder.add?.(makeSession(id, { terminalId: id, status: 'connecting', projectPath: AGENT, cliSource: 'claude' }));
    return ok({ ok: true, terminalId: id });
  };
  const h = deliverCtx({ central: GLOBAL, sessions: [centralCard, ...sessions], centrals: [GLOBAL], workers, routes: { ...ROUTES, 'POST /terminals': open, ...routes } });
  holder.add = (s) => {
    h.sessions.push(s);
    h.f.setSession(s);
  };
  const deps: OpenWorkerDeps = { knownProjects: async () => [AGENT], home: HOME, realpath: async (p) => p, planWindowPct: () => null, now: () => NOW, workers };
  seam.open = deps;
  const rows: ActivityInput[] = [];
  const stop = startRerouter({
    ledger: h.base,
    contextOf: (centralId) => (centralId === GLOBAL.centralId ? h.ctx : null),
    activity: { logActivity: (row) => rows.push(row) },
  });
  /** The worker's terminal closes mid-turn: its card ends, then the terminals' exit feed fires. */
  const die = (sessionId: string): void => {
    const s = h.sessions.find((x) => x.sessionId === sessionId)!;
    const i = h.sessions.indexOf(s);
    h.sessions[i] = { ...s, status: 'ended' };
    h.f.patch(sessionId, { status: 'ended' });
    h.f.exit(s.terminalId!);
  };
  const terminals = () => h.client.calls.filter((c) => c.method === 'POST' && c.path === '/terminals');
  return { ...h, rows, stop, die, terminals };
}

/** Delegates to "auto" and lets the worker take its prompt: the task is running in `expected`. */
async function delegate(w: ReturnType<typeof world>, expected: string, args: Record<string, unknown> = {}): Promise<string> {
  const data = (await run('task_delegate', { to: 'auto', task: TASK, ...args }, w.ctx)).data as { tasks: Array<{ taskId: string; sessionId: string }> };
  await flush();
  expect(data.tasks[0].sessionId).toBe(expected);
  if (w.f.sessions.get(expected)?.status === 'connecting') {
    w.f.hook('SessionStart', expected, { status: 'idle' });
    await flush();
  }
  w.f.takePrompt(expected);
  return data.tasks[0].taskId;
}

describe('the re-router', () => {
  it('a worker that dies mid-task is re-routed once', async () => {
    const w = world();
    const id = await delegate(w, A);

    w.die(A);
    await flush();

    const t = w.base.get(id)!;
    expect(t).toMatchObject({ taskId: id, sessionId: B, retargetedFrom: A, route: { by: 'auto' } });
    expect(['queued', 'sent']).toContain(t.state);
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([A, B]);
    expect(w.f.submits[1].text).toBe(w.f.submits[0].text);
    // Logged as the central's own, in AASC's words: the re-route and where it went.
    expect(w.rows).toEqual([
      expect.objectContaining({ centralId: GLOBAL.centralId, taskId: id, outcome: 'ok', targetSessionId: B, summary: expect.stringMatching(/^re-routed T\d+ from #sess-aaa: routed to #sess-bbb: /) }),
    ]);
    expect(JSON.stringify(w.rows)).not.toMatch(/flaky|agent-manager/);
    w.stop();
  });

  it('leaves the failed session out, even while its card still looks alive', async () => {
    const w = world();
    const id = await delegate(w, A);
    // The exit feed fires before the card is updated: in the central's view A still looks like the best idle session.
    const i = w.sessions.findIndex((s) => s.sessionId === A);
    w.sessions[i] = { ...w.sessions[i], status: 'idle' };
    w.f.exit(`t-${A}`);
    await flush();

    expect(w.base.get(id)).toMatchObject({ sessionId: B, retargetedFrom: A });
    w.stop();
  });

  it('a second death stays failed', async () => {
    const w = world();
    const id = await delegate(w, A);
    w.die(A);
    await flush();
    w.f.takePrompt(B);

    w.die(B);
    await flush();

    expect(w.base.get(id)).toMatchObject({ state: 'failed', sessionId: B, retargetedFrom: A });
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([A, B]);
    expect(w.rows).toHaveLength(1);
    w.stop();
  });

  it('a cancelled task is not re-routed', async () => {
    const w = world();
    const id = await delegate(w, A);
    await w.ctx.ledger.cancel(id, GLOBAL.centralId, { mayPress: true });

    w.die(A);
    await flush();

    expect(w.base.get(id)?.state).toBe('cancelled');
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([A]);
    expect(w.rows).toEqual([]);
    w.stop();
  });

  it('a task the central named the session for is never re-routed', async () => {
    const w = world();
    const data = (await run('task_delegate', { to: A, task: TASK }, w.ctx)).data as { tasks: Array<{ taskId: string }> };
    await flush();
    w.f.takePrompt(A);

    w.die(A);
    await flush();

    expect(w.base.get(data.tasks[0].taskId)?.state).toBe('failed');
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([A]);
    w.stop();
  });

  it('a re-route asks what the central asked: newOnly opens another new session', async () => {
    const w = world();
    const id = await delegate(w, 'term-new-1', { newOnly: true });

    w.die('term-new-1');
    await flush();

    expect(w.terminals()).toHaveLength(2);
    expect(w.base.get(id)).toMatchObject({ sessionId: 'term-new-2', retargetedFrom: 'term-new-1' });
    w.f.hook('SessionStart', 'term-new-2', { status: 'idle' });
    await flush();
    expect(w.f.submits.map((s) => s.sessionId)).toEqual(['term-new-1', 'term-new-2']);
    w.stop();
  });

  it('a re-route that finds nowhere to go leaves the task failed, and says so', async () => {
    const w = world([worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN })]);
    const id = await delegate(w, A);
    // Nothing else in the project, and no new session may open now.
    seam.open = { ...(seam.open as OpenWorkerDeps), planWindowPct: () => 99 };

    w.die(A);
    await flush();

    expect(w.base.get(id)).toMatchObject({ state: 'failed', sessionId: A, retargetedFrom: null });
    expect(w.rows).toEqual([expect.objectContaining({ taskId: id, outcome: 'failed', summary: `${id} not re-routed (BUDGET)`, detail: { code: 'BUDGET' } })]);
    w.stop();
  });

  it('a worker it opened is closed when the re-route then fails, and the failure row names it (P4-28)', async () => {
    const w = world([worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN })], {
      'DELETE /sessions/term-new-1': ok({ ok: true, removed: true }),
    });
    const id = await delegate(w, A);
    // The new worker opens, then the move into it is refused (another central took it first).
    w.ctx.ledger = {
      ...w.ctx.ledger,
      retarget: () => {
        throw new ToolError('BUSY', 'That session is working on a task a central gave it.');
      },
    };

    w.die(A);
    await flush();

    expect(w.terminals()).toHaveLength(1);
    expect(w.client.calls.filter((c) => c.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/sessions/term-new-1' }]);
    expect(w.base.get(id)).toMatchObject({ state: 'failed', sessionId: A });
    const failure = w.rows.find((r) => r.outcome === 'failed');
    expect(failure).toMatchObject({ taskId: id, detail: { code: 'BUSY', openedSession: 'term-new-1', closed: true } });
    expect(failure?.summary).toBe(`${id} not re-routed (BUSY); closed #term-new the session AASC opened for it`);
    w.stop();
  });

  it('a worker it opened whose card is gone by then is closed through its terminal (P4-44)', async () => {
    const w = world([worker(A, AGENT, { ...withContext(10), lastActivityAt: NOW - MIN })], {
      'DELETE /terminals/term-new-1': ok({ ok: true }),
    });
    const id = await delegate(w, A);
    w.ctx.ledger = {
      ...w.ctx.ledger,
      retarget: () => {
        // A person closed the new worker in the gap: no card shows it any more.
        w.sessions.splice(w.sessions.findIndex((x) => x.sessionId === 'term-new-1'), 1);
        throw new ToolError('BUSY', 'That session is working on a task a central gave it.');
      },
    };

    w.die(A);
    await flush();

    expect(w.client.calls.filter((c) => c.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/terminals/term-new-1' }]);
    expect(w.rows.find((r) => r.outcome === 'failed')).toMatchObject({ taskId: id, detail: { code: 'BUSY', openedSession: 'term-new-1', closed: true } });
    w.stop();
  });

  it('stops listening when stopped', async () => {
    const w = world();
    const id = await delegate(w, A);
    w.stop();

    w.die(A);
    await flush();

    expect(w.base.get(id)?.state).toBe('failed');
    expect(w.f.submits).toHaveLength(1);
  });
});
