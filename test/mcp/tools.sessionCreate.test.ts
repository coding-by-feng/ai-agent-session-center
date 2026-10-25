// test/mcp/tools.sessionCreate.test.ts — session_create (server/mcp/tools/sessionCreate.ts): a central opens a
// session of its own (openWorker.ts), with what it leaves out taken from the folder's profile (projectIndex.ts
// `profileOf`), filed into a room (a room central's: always its own), and, with `firstTask`, a task that waits for the
// new session to start (Ruling P4-6). The worker opener's real dependencies (workerDeps.ts) are replaced: nothing here
// reaches a disk, a terminal or a process; POST /terminals is a fake that adds the new card the route would.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { OpenWorkerDeps } from '../../server/mcp/openWorker.js';
import { allTools } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { ToolError } from '../../server/mcp/types.js';
import { createWorkerRegistry, type WorkerRegistry } from '../../server/mcp/workers.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { deliverCtx } from './deliverToolFixtures.js';
import { fakeClient, makeCentral, makeRoom, makeSession, NOW, ok, run, runRefused, type Answer, type ApiCall } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));
const seam = vi.hoisted(() => ({ open: null as unknown }));
vi.mock('../../server/mcp/workerDeps.js', () => ({
  openWorkerDepsFor: () => seam.open,
  routeDepsFor: () => ({}),
  knownRootsOf: async () => [],
  planWindowPct: () => null,
}));

const HOME = '/home/u';
const PROJ = `${HOME}/code/app`;
const NEW = 'term-new-1';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** The worker opener's deps on a fake home, every folder real and known, recording into `workers`. */
function openDeps(workers: WorkerRegistry, over: Partial<OpenWorkerDeps> = {}): OpenWorkerDeps {
  return { knownProjects: async () => [PROJ], home: HOME, realpath: async (p) => p, planWindowPct: () => null, now: () => NOW, workers, ...over };
}

/** The central's own card, in default mode. */
const cardOf = (c: ReturnType<typeof makeCentral>): Session =>
  makeSession(`card-${c.centralId}`, {
    terminalId: c.terminalId,
    status: 'waiting',
    permissionMode: 'default',
    central: { centralId: c.centralId, kind: c.kind, scopeRef: c.scopeRef },
  });

/** A world whose POST /terminals opens a new connecting card (in the context and the ledger) the way the route does. */
function world(opts: { central?: ReturnType<typeof makeCentral>; sessions?: Session[]; rooms?: ReturnType<typeof makeRoom>[] } = {}) {
  const central = opts.central ?? makeCentral('global', null, { terminalId: 'term-c' });
  const workers = createWorkerRegistry({ controller: () => null });
  const sessions: Session[] = [cardOf(central), ...(opts.sessions ?? [])];
  const holder: { add?: (s: Session) => void } = {};
  const opened: Answer = (call: ApiCall) => {
    const body = call.body as { workingDir: string; command: string };
    holder.add?.(makeSession(NEW, { terminalId: NEW, status: 'connecting', projectPath: body.workingDir, cliSource: body.command.startsWith('codex') ? 'codex' : 'claude' }));
    return ok({ ok: true, terminalId: NEW });
  };
  const h = deliverCtx({
    central,
    sessions,
    rooms: opts.rooms ?? [],
    workers,
    routes: { 'POST /terminals': opened, 'POST /rooms/ops': ok({ ok: true, opId: 'op-1' }, 202), 'GET /db/sessions': ok({ sessions: [], total: 0, page: 1, pageSize: 1 }) },
  });
  holder.add = (s) => {
    h.sessions.push(s);
    h.f.setSession(s);
  };
  seam.open = openDeps(workers);
  const posts = (path: string) => h.client.calls.filter((c) => c.method === 'POST' && c.path === path);
  return { ...h, central, workers, posts };
}

interface CreateData {
  sessionId: string;
  terminalId: string;
  cli: string;
  model: string | null;
  effort: string | null;
  roomId: string | null;
  filed: boolean;
  note: string | null;
  taskId: string | null;
  taskState: string | null;
}

describe('session_create', () => {
  it('fills from the profile', async () => {
    // The folder's newest session ran Codex with a model and an effort, in room r7.
    const earlier = makeSession('old-1', {
      projectPath: PROJ, terminalId: 'term-old', status: 'ended', cliSource: 'codex', model: 'gpt-5.1-codex', effortLevel: 'high',
    });
    const w = world({ sessions: [earlier], rooms: [makeRoom('r7', ['old-1'])] });

    const result = await run('session_create', { agent: 'codex', folder: PROJ }, w.ctx);

    expect(w.posts('/terminals')[0].body).toMatchObject({ workingDir: PROJ, command: 'codex', model: 'gpt-5.1-codex', effortLevel: 'high' });
    expect(w.posts('/rooms/ops')[0].body).toEqual({ type: 'move', sessionId: NEW, roomId: 'r7' });
    expect(result.data).toMatchObject({ sessionId: NEW, cli: 'codex', model: 'gpt-5.1-codex', effort: 'high', roomId: 'r7', filed: true, taskId: null });
    expect(w.workers.of(w.central.centralId).map((x) => x.terminalId)).toEqual([NEW]);
  });

  it('takes what it is given over the profile, and copies nothing from a profile of another CLI', async () => {
    const earlier = makeSession('old-1', { projectPath: PROJ, terminalId: 'term-old', status: 'ended', cliSource: 'codex', model: 'gpt-5.1-codex', effortLevel: 'minimal' });
    const w = world({ sessions: [earlier] });

    await run('session_create', { agent: 'claude', folder: PROJ, title: 'Docs pass' }, w.ctx);
    const body = w.posts('/terminals')[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ command: 'claude', sessionTitle: 'Docs pass' });
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('effortLevel');

    // A Codex profile whose effort Codex takes is copied unless the call says otherwise.
    const given = world({ sessions: [earlier] });
    await run('session_create', { agent: 'codex', folder: PROJ, model: 'o4', effort: 'low' }, given.ctx);
    expect(given.posts('/terminals')[0].body).toMatchObject({ command: 'codex', model: 'o4', effortLevel: 'low', sessionTitle: 'app' });
  });

  it("a room central's worker goes into its room", async () => {
    const central = makeCentral('room', 'r1', { terminalId: 'term-c' });
    const rooms = [makeRoom('r1', [], 'Backend'), makeRoom('r2', [], 'Frontend')];
    // Its folder's usual room is another one: a room central files into its own all the same.
    const earlier = makeSession('old-1', { projectPath: PROJ, terminalId: 'term-old', status: 'ended', cliSource: 'claude' });
    const w = world({ central, sessions: [earlier], rooms: [makeRoom('r1', [], 'Backend'), makeRoom('r2', ['old-1'], 'Frontend')] });

    const data = (await run('session_create', { agent: 'claude', folder: PROJ }, w.ctx)).data as CreateData;

    expect(w.posts('/rooms/ops')[0].body).toEqual({ type: 'move', sessionId: NEW, roomId: 'r1' });
    expect(data).toMatchObject({ roomId: 'r1', filed: true });
    // Its worker is in its scope at once, filed or not.
    expect(w.ctx.inScope(w.sessions.find((s) => s.sessionId === NEW)!)).toBe(true);

    const other = world({ central, rooms });
    expect((await runRefused('session_create', { agent: 'claude', folder: PROJ, room: 'Frontend' }, other.ctx)).code).toMatch(/DENIED|NOT_FOUND/);
    expect(other.posts('/terminals')).toEqual([]);
  });

  it('names a room by id or by its exact name, and refuses one it cannot see without repeating it', async () => {
    const rooms = [makeRoom('r1', [], 'Backend'), makeRoom('r2', [], 'Frontend')];
    const byName = world({ rooms });
    await run('session_create', { agent: 'claude', folder: PROJ, room: 'Frontend' }, byName.ctx);
    expect(byName.posts('/rooms/ops')[0].body).toMatchObject({ roomId: 'r2' });

    const byId = world({ rooms });
    await run('session_create', { agent: 'claude', folder: PROJ, room: 'r1' }, byId.ctx);
    expect(byId.posts('/rooms/ops')[0].body).toMatchObject({ roomId: 'r1' });

    const none = world({ rooms });
    const err = await runRefused('session_create', { agent: 'claude', folder: PROJ, room: 'Secret-Room-42' }, none.ctx);
    expect(err.code).toBe('NOT_FOUND');
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain('Secret-Room-42');
    expect(none.posts('/terminals')).toEqual([]);
  });

  it('firstTask returns a queued task', async () => {
    const w = world();

    const result = await run('session_create', { agent: 'claude', folder: PROJ, firstTask: 'add a test for the parser' }, w.ctx);
    await flush();

    const data = result.data as CreateData;
    expect(data).toMatchObject({ sessionId: NEW, taskId: 'T1', taskState: 'queued' });
    expect(w.posts('/terminals')[0].body).toMatchObject({ sessionTitle: 'add a test for the parser' });
    // Nothing is typed until the new session has started (Ruling P4-6).
    expect(w.f.submits).toEqual([]);
    w.f.hook('SessionStart', NEW, { status: 'idle' });
    await vi.advanceTimersByTimeAsync(10);
    expect(w.f.submits.map((s) => s.sessionId)).toEqual([NEW]);
    expect(result.activity?.map((n) => n.taskId ?? null)).toEqual([null, 'T1']);
    expect(result.summary).toMatch(/T1/);
    expect(result.summary).toMatch(/task_wait/);
  });

  it('an explicit title is refused by the title rule; derived titles are cleaned (Ruling P3-23)', async () => {
    const refused = world();
    const err = await runRefused('session_create', { agent: 'claude', folder: PROJ, title: 'w --allowedTools Bash' }, refused.ctx);
    expect(err.code).toBe('INVALID');
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain('allowedTools');
    expect(refused.posts('/terminals')).toEqual([]);

    const fromTask = world();
    await run('session_create', { agent: 'claude', folder: PROJ, firstTask: 'run it with --add-dir / ; then `report`' }, fromTask.ctx);
    expect(fromTask.posts('/terminals')[0].body).toMatchObject({ sessionTitle: 'run it with add-dir / then report' });

    const fromFolder = world();
    await run('session_create', { agent: 'claude', folder: `${HOME}/code/--x;y` }, fromFolder.ctx);
    expect(fromFolder.posts('/terminals')[0].body).toMatchObject({ sessionTitle: 'xy' });
  });

  it('refuses a task that starts as a shell line before anything opens', async () => {
    const w = world();

    expect((await runRefused('session_create', { agent: 'claude', folder: PROJ, firstTask: '!rm -rf ~' }, w.ctx)).code).toBe('INVALID');
    expect(w.posts('/terminals')).toEqual([]);
  });

  it('is a write of the sessions toolset, phase 3', () => {
    const tool = allTools().find((t) => t.name === 'session_create')!;
    expect(tool).toMatchObject({ toolset: 'sessions', risk: 'write', phase: 3 });
    expect(tool.description).toMatch(/firstTask/);
  });
});

describe('session_create and the activity log', () => {
  function logged() {
    const registry = createCentralRegistry();
    const central = registry.mint({ ...globalInput(), permissionMode: 'default' });
    const card = makeSession('card-1', { terminalId: central.terminalId ?? 'term-card', status: 'waiting', permissionMode: 'default', central: { centralId: central.centralId, kind: 'global', scopeRef: null } });
    const sessions: Session[] = [card];
    const t = testDeliver({ sessions: () => sessions });
    const workers = createWorkerRegistry({ controller: () => null });
    seam.open = openDeps(workers);
    const api = fakeClient({ 'POST /terminals': ok({ ok: true, terminalId: NEW }), 'GET /db/sessions': ok({ sessions: [], total: 0, page: 1, pageSize: 1 }) });
    const deps: McpDeps = {
      registry,
      client: () => api,
      sessions: () => sessions,
      rooms: () => [],
      events: createEventHub(fakeBus().subscribe),
      now: () => NOW,
      deliver: t.deliver,
      workers,
    };
    const tool = allTools().find((x) => x.name === 'session_create')!;
    const call = (args: Record<string, unknown>) => runTool(tool, args, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' });
    return { ...t, central, api, call };
  }

  it('refusals are logged with their reason', async () => {
    const w = logged();

    await expect(w.call({ agent: 'claude', folder: PROJ, permissionMode: 'bypassPermissions' })).rejects.toBeInstanceOf(ToolError);

    const rows = w.activity.listActivity();
    expect(rows).toEqual([
      expect.objectContaining({ tool: 'session_create', outcome: 'refused', detail: { code: 'DENIED' }, summary: expect.stringMatching(/no looser/) }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(PROJ);
    expect(w.api.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('an open is logged in AASC’s words, never the folder or the title', async () => {
    const w = logged();

    await w.call({ agent: 'claude', folder: PROJ, title: 'Secret plan' });

    const rows = w.activity.listActivity();
    expect(rows).toEqual([expect.objectContaining({ tool: 'session_create', outcome: 'ok', targetSessionId: NEW, summary: 'opened a claude session of its own' })]);
    expect(JSON.stringify(rows)).not.toMatch(/Secret plan|code\/app/);
  });
});
