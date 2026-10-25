// test/mcp/tools.sessionEnd.test.ts — session_interrupt, session_restart, session_kill and session_close
// (server/mcp/tools/sessionEnd.ts, P5 Task 4). All four are `destructive`: `confirm` names the target (`resolveTarget`),
// asks the ending rails (`ctx.mayEnd`, P5-8), runs the tool's own checks, then decides the card:
//   interrupt  none on the caller's own worker; refused before any card when nothing runs, or the turn is its own task
//   restart    none for the caller's own idle worker (ownIdle.ts, P5-4); the relaunch rule and the cap first (P5-9)
//   kill       always asks (P5-5); refused before any card when AASC cannot tell which process is the session's (P5-6)
//   close      none for the caller's own idle worker; a pinned card asks
// `run` asks the rails again; an exempt call whose card needs asking by then is INVALID (`allowedByPerson` false). The
// fingerprint is the terminal and whether the card is pinned (P5-34), never a pid: a central's kill only closes the
// card's own terminal (Ruling P5-33), so a kill approved for one terminal runs nothing on another, and the route is told
// which terminal that was (`expectTerminalId`).
//
// Only the fake client answers: no route runs, nothing reaches a process. The worker opener's real dependencies
// (workerDeps.ts) are replaced, so nothing reaches the disk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { createConfirmBook } from '../../server/mcp/confirm.js';
import { unwiredLedger } from '../../server/mcp/deliver.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { Ledger } from '../../server/mcp/ledger.js';
import type { TaskRecord } from '../../server/mcp/ledgerTypes.js';
import type { WorkerController } from '../../server/mcp/workers.js';
import { allTools, type ConfirmAsk, type ToolDef } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { systemWriteTools } from '../../server/mcp/tools/systemWrite.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { createWorkerRegistry } from '../../server/mcp/workers.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { fakeClient, makeCentral, makeCtx, makeSession, NOW, ok, unheard, type Answer } from './toolHarness.js';

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
/** The worker's id: a CLI session id, so a restart may bring its conversation back. */
const ID = '1a2b3c4d-2222-4333-8444-000000000001';
const TERMINAL = 'term-w1';
const PID = 4242;
const TOOLS = ['session_interrupt', 'session_restart', 'session_kill', 'session_close'] as const;
type EndTool = (typeof TOOLS)[number];
const CHANGED_NOW = 'That session changed; call again.';
const NO_SAFE_TARGET = 'AASC ends a session only through its own terminal, and that session has none it can close.';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const toolOf = (name: string): ToolDef => {
  const tool = allTools().find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
};

/** The central's own card, in `mode`. */
const cardOf = (c: CentralRecord, mode: string | null = 'default'): Session =>
  makeSession(`card-${c.centralId}`, {
    terminalId: c.terminalId,
    status: 'waiting',
    permissionMode: mode,
    central: { centralId: c.centralId, kind: c.kind, scopeRef: c.scopeRef },
  });

/** A plain Claude card in the project, started as a bare claude, in its own terminal with a hook-reported pid. */
const worker = (over: Partial<Session> = {}): Session =>
  makeSession(ID, {
    status: 'idle',
    cliSource: 'claude',
    projectPath: PROJ,
    startupCommand: 'claude',
    terminalId: TERMINAL,
    cachedPid: PID,
    ...over,
  });

const queueAnswer = (items: unknown[] | null): Answer => ok({ sessionId: ID, items, automation: null, updatedAt: 0 });

interface WorldOptions {
  /** The worker is one the central opened (its own). Default true. */
  own?: boolean;
  card?: Session;
  extra?: Session[];
  centralMode?: string | null;
  routes?: Record<string, Answer>;
  ledger?: Ledger;
  isOpsTerminal?: (terminalId: string) => boolean;
  allowed?: boolean;
}

function world(o: WorldOptions = {}) {
  const central = makeCentral('global', null, { terminalId: 'term-c' });
  const who: { controller: WorkerController | null } = { controller: null };
  const workers = createWorkerRegistry({ controller: () => who.controller });
  const card = o.card ?? worker();
  if (o.own ?? true) {
    workers.add({ centralId: central.centralId, terminalId: card.terminalId ?? TERMINAL, openedAt: NOW - 600_000, folder: PROJ, cli: 'claude' });
  }
  const id = card.sessionId;
  const routes: Record<string, Answer> = {
    [`GET /sessions/${id}/queue`]: queueAnswer([]),
    [`POST /sessions/${id}/interrupt`]: ok({ ok: true, pressed: true }),
    [`POST /sessions/${id}/restart-terminal`]: ok({ ok: true, terminalId: 'term-new-1' }),
    [`POST /sessions/${id}/kill`]: ok({
      ok: true,
      pid: PID,
      killedPid: PID,
      source: 'ssh',
      sessionId: id,
      terminalId: card.terminalId ?? null,
      processShared: false,
      sharedProcessPid: null,
    }),
    [`DELETE /sessions/${id}`]: ok({ ok: true, removed: true }),
    ...o.routes,
  };
  const allowedBox = { value: o.allowed ?? false };
  const h = makeCtx({
    central,
    sessions: [cardOf(central, o.centralMode ?? 'default'), card, ...(o.extra ?? [])],
    workers,
    routes,
    controller: () => who.controller,
    ...(o.ledger ? { ledger: o.ledger } : {}),
    ...(o.isOpsTerminal ? { isOpsTerminal: o.isOpsTerminal } : {}),
    allowedByPerson: () => allowedBox.value,
  });
  seam.open = { knownProjects: async () => [PROJ], home: HOME, realpath: async (p: string) => p, planWindowPct: () => null, now: () => NOW, workers };
  const writes = () => h.client.calls.filter((c) => c.method !== 'GET');
  /** A person types into the worker: it is theirs now (P4-3), long enough ago that the 60 s rail lets it through. */
  const adopt = (): void => {
    who.controller = { clientId: 'mac-window-1', lastActivityAt: NOW - 120_000, lastInputAt: NOW - 120_000 };
  };
  return { ...h, central, workers, card, writes, adopt, allowedBox };
}

type World = ReturnType<typeof world>;

const confirmOf = async (w: World, name: EndTool, id = ID): Promise<ConfirmAsk | null> => {
  const tool = toolOf(name);
  if (tool.confirm === undefined) throw new Error(`${name} has no confirm`);
  return tool.confirm({ id }, w.ctx);
};

const runOf = (w: World, name: EndTool, id = ID) => toolOf(name).run({ id }, w.ctx);

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
}

/** A refusal's words, for "never repeats the id" checks. */
const wordsOf = (e: ToolError): string => `${e.message} ${e.hint ?? ''}`;

/** An open task of the calling central in the worker, as its ledger lists it. */
const ownTask = (taskId: string): TaskRecord => ({
  taskId,
  centralId: 'central-1',
  sessionId: ID,
  terminalId: TERMINAL,
  task: 'do it',
  answerFormat: null,
  state: 'running',
  createdAt: NOW - 10_000,
  sentAt: NOW - 9_000,
  updatedAt: NOW - 9_000,
  promptKey: 'k',
  answer: null,
  answerTruncated: false,
  error: null,
  history: [],
  route: null,
  retargetedFrom: null,
});

/** The ledger of a central whose own task T12 holds the worker: the lock is that task's alone. */
const ledgerWithOwnTask = (): Ledger => ({
  ...unwiredLedger,
  list: () => [ownTask('T12')],
  isLocked: (sessionId: string, exceptTaskId?: string) => sessionId === ID && exceptTaskId !== 'T12',
});

// ---------------------------------------------------------------------------

describe('the card each tool decides', () => {
  it('kill of its own idle worker still asks', async () => {
    const w = world();
    const ask = await confirmOf(w, 'session_kill');

    expect(ask).not.toBeNull();
    expect(ask?.summary).toMatch(/^kill session 1a2b3c4d \(its process and terminal end\)$/);
    expect(ask?.targetSessionId).toBe(ID);
    expect(ask?.fingerprint).toBe(`terminal:${TERMINAL}|pinned:0`);
    expect(ask?.fingerprint).not.toContain(String(PID));
    expect(w.writes()).toEqual([]);
  });

  it('close of its own idle worker runs with no card', async () => {
    const w = world();
    expect(await confirmOf(w, 'session_close')).toBeNull();

    const result = await runOf(w, 'session_close');

    expect(w.writes()).toEqual([{ method: 'DELETE', path: `/sessions/${ID}` }]);
    expect(result.data).toEqual({ sessionId: ID, removed: true });
    expect(result.activity?.[0]).toMatchObject({ targetSessionId: ID });
  });

  it('restart of its own idle worker runs with no card and answers own false', async () => {
    const w = world();
    expect(await confirmOf(w, 'session_restart')).toBeNull();

    const result = await runOf(w, 'session_restart');

    expect(w.writes()).toEqual([{ method: 'POST', path: `/sessions/${ID}/restart-terminal`, body: { confirm: true } }]);
    expect(result.data).toEqual({ sessionId: ID, terminalId: 'term-new-1', own: false });
    expect(result.summary).toMatch(/no longer one of your own/);
    // It counts against the minute's opens, and is not recorded as a new own worker.
    expect(w.workers.of(w.central.centralId).map((x) => x.terminalId)).toEqual([TERMINAL]);
  });

  it('close of a pinned own worker asks, and the summary says it will not come back', async () => {
    const w = world({ card: worker({ pinned: true }) });
    const ask = await confirmOf(w, 'session_close');

    expect(ask?.summary).toMatch(/^close session 1a2b3c4d and remove its card/);
    expect(ask?.summary).toMatch(/pinned.*will not come back/);
  });

  it('kill of a pinned card says the kill unpins it and it will not come back', async () => {
    const w = world({ card: worker({ pinned: true }) });
    expect((await confirmOf(w, 'session_kill'))?.summary).toMatch(/it is pinned: a kill unpins it and it will not come back/);
  });

  it('restart and close of a worker that is not the caller’s own ask', async () => {
    const w = world({ own: false });
    expect((await confirmOf(w, 'session_restart'))?.summary).toBe(
      'restart session 1a2b3c4d in a new terminal (its turn, if any, ends)',
    );
    expect((await confirmOf(w, 'session_close'))?.summary).toBe('close session 1a2b3c4d and remove its card');
  });

  it('an own worker with a queued prompt switched on, or an unreadable queue, needs a card', async () => {
    const queued = world({ routes: { [`GET /sessions/${ID}/queue`]: queueAnswer([{ id: 1, text: 'next' }]) } });
    expect(await confirmOf(queued, 'session_close')).not.toBeNull();
    expect(await confirmOf(queued, 'session_restart')).not.toBeNull();

    const unreadable = world({ routes: { [`GET /sessions/${ID}/queue`]: { ok: false, status: 500, data: null, error: 'boom' } } });
    expect(await confirmOf(unreadable, 'session_close')).not.toBeNull();

    // A queue with no record yet (items null) holds nothing.
    const none = world({ routes: { [`GET /sessions/${ID}/queue`]: queueAnswer(null) } });
    expect(await confirmOf(none, 'session_close')).toBeNull();
  });

  it('an exempt close whose worker was adopted before run is INVALID', async () => {
    const w = world();
    expect(await confirmOf(w, 'session_close')).toBeNull();
    w.adopt();

    const e = await refusal(runOf(w, 'session_close'));

    expect(e.code).toBe('INVALID');
    expect(e.message).toBe(CHANGED_NOW);
    expect(w.writes()).toEqual([]);
  });

  it('an exempt restart whose worker started working before run is INVALID', async () => {
    const w = world();
    expect(await confirmOf(w, 'session_restart')).toBeNull();
    w.sessions[1] = { ...w.sessions[1], status: 'working' };

    const e = await refusal(runOf(w, 'session_restart'));

    expect(e.message).toBe(CHANGED_NOW);
    expect(w.writes()).toEqual([]);
  });

  it('a close the person allowed runs even though it needs a card', async () => {
    const w = world({ own: false, allowed: true });
    expect(await confirmOf(w, 'session_close')).not.toBeNull();

    expect((await runOf(w, 'session_close')).data).toEqual({ sessionId: ID, removed: true });
  });
});

describe('session_interrupt', () => {
  it('interrupt of an idle card is INVALID before any card', async () => {
    const w = world({ own: false });
    const e = await refusal(confirmOf(w, 'session_interrupt'));

    expect(e.code).toBe('INVALID');
    expect(e.message).toBe('Nothing is running there to interrupt.');
    expect(w.client.calls).toEqual([]);
  });

  it('interrupt of a card with no terminal is INVALID before any card', async () => {
    const w = world({ own: false, card: worker({ status: 'working', terminalId: null }) });
    expect((await refusal(confirmOf(w, 'session_interrupt'))).message).toBe('Nothing is running there to interrupt.');
  });

  it('interrupt of a card that has not reported that it started is UNAVAILABLE', async () => {
    const w = world({ own: false, card: unheard(worker({ status: 'working' })) });
    expect((await refusal(confirmOf(w, 'session_interrupt'))).code).toBe('UNAVAILABLE');
    expect(w.client.calls).toEqual([]);
  });

  it('interrupt of the caller’s own task’s turn is INVALID naming task_cancel', async () => {
    const w = world({ card: worker({ status: 'working' }), ledger: ledgerWithOwnTask() });
    const e = await refusal(confirmOf(w, 'session_interrupt'));

    expect(e.code).toBe('INVALID');
    expect(e.message).toBe('That turn is your task T12: task_cancel stops it and ends the task.');
    expect(w.client.calls).toEqual([]);
  });

  it('interrupt of its own worker mid-turn runs with no card', async () => {
    const w = world({ card: worker({ status: 'working' }) });
    expect(await confirmOf(w, 'session_interrupt')).toBeNull();

    const result = await runOf(w, 'session_interrupt');

    expect(w.writes()).toEqual([{ method: 'POST', path: `/sessions/${ID}/interrupt`, body: { confirm: true } }]);
    expect(result.data).toEqual({ sessionId: ID, pressed: true });
  });

  it('interrupt at a dialog runs too: the Esc declines it', async () => {
    const w = world({ card: worker({ status: 'approval' }) });
    expect(await confirmOf(w, 'session_interrupt')).toBeNull();
    expect((await runOf(w, 'session_interrupt')).data).toEqual({ sessionId: ID, pressed: true });
  });

  it('interrupt of another session mid-turn asks', async () => {
    const w = world({ own: false, card: worker({ status: 'working' }) });
    const ask = await confirmOf(w, 'session_interrupt');

    expect(ask?.summary).toBe('stop the running turn of session 1a2b3c4d (Esc; an open dialog is declined)');
    expect(ask?.targetSessionId).toBe(ID);
    expect(ask?.fingerprint).toContain(TERMINAL);
  });

  it('an exempt interrupt whose worker was adopted before run is INVALID', async () => {
    const w = world({ card: worker({ status: 'working' }) });
    expect(await confirmOf(w, 'session_interrupt')).toBeNull();
    w.adopt();

    expect((await refusal(runOf(w, 'session_interrupt'))).message).toBe(CHANGED_NOW);
    expect(w.writes()).toEqual([]);
  });

  it('pressed false says nothing was running by then; the route’s not_started is UNAVAILABLE', async () => {
    const idle = world({ card: worker({ status: 'working' }), routes: { [`POST /sessions/${ID}/interrupt`]: ok({ ok: true, pressed: false }) } });
    const result = await runOf(idle, 'session_interrupt');
    expect(result.data).toEqual({ sessionId: ID, pressed: false });
    expect(result.summary).toMatch(/nothing was running/i);

    const notStarted = world({
      card: worker({ status: 'working' }),
      routes: { [`POST /sessions/${ID}/interrupt`]: { ok: false, status: 409, data: { ok: false, error: 'not_started' }, error: 'not_started' } },
    });
    expect((await refusal(runOf(notStarted, 'session_interrupt'))).code).toBe('UNAVAILABLE');
  });
});

describe('session_kill', () => {
  it('kill with no cachedPid and no terminal is UNAVAILABLE before any card', async () => {
    const w = world({ own: false, card: worker({ cachedPid: null, terminalId: null }) });
    const e = await refusal(confirmOf(w, 'session_kill'));

    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).toBe(NO_SAFE_TARGET);
    expect(w.client.calls).toEqual([]);
  });

  it('kill of a card with a cachedPid but no terminal (a card restored after a restart) is UNAVAILABLE before any card', async () => {
    const w = world({ own: false, card: worker({ cachedPid: PID, terminalId: null }) });
    const e = await refusal(confirmOf(w, 'session_kill'));

    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).toBe(NO_SAFE_TARGET);
    expect(wordsOf(e)).not.toContain(String(PID));
    expect(w.client.calls).toEqual([]);
    // run asks again: an allowed run on a card that lost its terminal posts nothing.
    const allowed = world({ own: false, allowed: true, card: worker({ cachedPid: PID, terminalId: null }) });
    expect((await refusal(runOf(allowed, 'session_kill'))).code).toBe('UNAVAILABLE');
    expect(allowed.writes()).toEqual([]);
  });

  it('kill of an ended card points to session_close', async () => {
    const w = world({ own: false, card: worker({ status: 'ended' }) });
    const e = await refusal(confirmOf(w, 'session_kill'));

    expect(e.code).toBe('INVALID');
    expect(wordsOf(e)).toMatch(/session_close/);
  });

  it('kill after the terminal changed is INVALID (the fingerprint); a new pid is not part of it', async () => {
    const w = world({ own: false });
    const before = await confirmOf(w, 'session_kill');
    w.sessions[1] = { ...w.sessions[1], terminalId: 'term-w2' };
    const after = await confirmOf(w, 'session_kill');
    w.sessions[1] = { ...w.sessions[1], terminalId: TERMINAL, cachedPid: PID + 1 };
    const newPid = await confirmOf(w, 'session_kill');

    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    // The kill never signals a pid (P5-33), so a pid the hook reports later changes nothing the person allowed.
    expect(newPid?.fingerprint).toBe(before?.fingerprint);
  });

  it('a kill the person did not allow runs nothing', async () => {
    const w = world();
    const e = await refusal(runOf(w, 'session_kill'));

    expect(e.code).toBe('INVALID');
    expect(w.writes()).toEqual([]);
  });

  it('an allowed kill calls the route with confirm and answers its fields', async () => {
    const w = world({ allowed: true });
    const result = await runOf(w, 'session_kill');

    expect(w.writes()).toEqual([{ method: 'POST', path: `/sessions/${ID}/kill`, body: { confirm: true, expectTerminalId: TERMINAL } }]);
    expect(result.data).toEqual({ sessionId: ID, killedPid: PID, terminalId: TERMINAL, processShared: false });
  });

  it('the route’s changed (another terminal by the time it ran) is the gate’s changed refusal', async () => {
    const w = world({
      allowed: true,
      routes: { [`POST /sessions/${ID}/kill`]: { ok: false, status: 409, data: { ok: false, error: 'changed' }, error: 'changed' } },
    });
    const e = await refusal(runOf(w, 'session_kill'));

    expect(e.code).toBe('INVALID');
    expect(e.message).toBe('What you asked about changed after the person was asked, so nothing was done.');
  });

  it('the route’s no_safe_target is UNAVAILABLE and a survivor is UNAVAILABLE in fixed words', async () => {
    const unsafe = world({
      allowed: true,
      routes: { [`POST /sessions/${ID}/kill`]: { ok: false, status: 409, data: { ok: false, error: 'no_safe_target' }, error: 'no_safe_target' } },
    });
    const e = await refusal(runOf(unsafe, 'session_kill'));
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).toBe(NO_SAFE_TARGET);

    const survivor = world({
      allowed: true,
      routes: { [`POST /sessions/${ID}/kill`]: { ok: false, status: 500, data: { ok: false, error: 'Process 4242 could not be terminated' }, error: 'x' } },
    });
    const s = await refusal(runOf(survivor, 'session_kill'));
    expect(s.code).toBe('UNAVAILABLE');
    expect(s.message).toBe('A process in that session’s terminal survived the kill: its terminal was closed and its card unpinned, but the card was not removed.');
    expect(wordsOf(s)).not.toContain(String(PID));
    expect(wordsOf(s)).not.toContain('could not be terminated');
  });
});

describe('the fingerprints (P5-3, P5-34)', () => {
  it('a pin added after the card was asked changes every tool’s fingerprint', async () => {
    for (const name of TOOLS) {
      const mid = name === 'session_interrupt' ? { status: 'working' as const } : {};
      const w = world({ own: false, card: worker(mid) });
      const before = await confirmOf(w, name);
      w.sessions[1] = { ...w.sessions[1], pinned: true };
      const after = await confirmOf(w, name);

      expect(before?.fingerprint, name).toBe(`terminal:${TERMINAL}|pinned:0`);
      expect(after?.fingerprint, name).toBe(`terminal:${TERMINAL}|pinned:1`);
    }
  });
});

describe('session_restart', () => {
  it('restart of a bypass card by a default central is DENIED', async () => {
    const w = world({ own: false, card: worker({ permissionMode: 'bypassPermissions' }) });
    const e = await refusal(confirmOf(w, 'session_restart'));

    expect(e.code).toBe('DENIED');
    expect(w.client.calls).toEqual([]);
  });

  it('restart of a card whose stored command fails the relaunch rule is INVALID', async () => {
    const w = world({ own: false, card: worker({ startupCommand: 'claude --mcp-config /tmp/x.json' }) });
    const e = await refusal(confirmOf(w, 'session_restart'));

    expect(e.code).toBe('INVALID');
    expect(wordsOf(e)).not.toContain('mcp-config');
    expect(w.client.calls).toEqual([]);
  });

  it('restart of an ended card points to session_resume', async () => {
    const w = world({ own: false, card: worker({ status: 'ended' }) });
    const e = await refusal(confirmOf(w, 'session_restart'));

    expect(e.code).toBe('INVALID');
    expect(wordsOf(e)).toMatch(/session_resume/);
  });

  it('restart of a card whose id is not a CLI session id is UNAVAILABLE', async () => {
    const w = world({ own: false, card: worker({ sessionId: 'term-1790000000000-abc' }) });
    const e = await refusal(confirmOf(w, 'session_restart', 'term-1790000000000-abc'));

    expect(e.code).toBe('UNAVAILABLE');
    expect(wordsOf(e)).not.toContain('term-1790000000000-abc');
  });
});

describe('the rails every tool asks first (P5-8)', () => {
  const otherCentral = (): Session =>
    makeSession('other-central-card', {
      terminalId: 'term-o',
      status: 'working',
      central: { centralId: 'central-2', kind: 'global', scopeRef: null },
    });

  it.each(TOOLS)('%s refuses another central’s card, an ops shell and a hands-off card before any card', async (name) => {
    const central = world({ own: false, card: otherCentral() });
    const a = await refusal(confirmOf(central, name, 'other-central-card'));
    expect(a.code, 'another central').toBe('INVALID');
    expect(a.message).toMatch(/another central: a central never ends one/);

    const ops = world({ own: false, card: worker({ status: 'working' }), isOpsTerminal: (t) => t === TERMINAL });
    expect((await refusal(confirmOf(ops, name))).code, 'ops shell').toBe('INVALID');

    const handsOff = world({ card: worker({ status: 'working', handsOff: true }) });
    expect((await refusal(confirmOf(handsOff, name))).code, 'hands-off').toBe('HANDS_OFF');

    for (const w of [central, ops, handsOff]) expect(w.client.calls).toEqual([]);
  });

  it.each(TOOLS)('%s asks the rails again when it runs', async (name) => {
    const w = world({ card: worker({ status: 'working' }), allowed: true });
    w.sessions[1] = { ...w.sessions[1], handsOff: true };
    expect((await refusal(runOf(w, name))).code).toBe('HANDS_OFF');
    expect(w.writes()).toEqual([]);
  });

  it('no refusal repeats the id the caller passed', async () => {
    const typed = 'zz-unknown-session-ref-7731';
    for (const name of TOOLS) {
      const w = world({ own: false });
      const e = await refusal(confirmOf(w, name, typed));
      expect(e.code).toBe('NOT_FOUND');
      expect(wordsOf(e)).not.toContain(typed);
    }
    const refusals = [
      await refusal(confirmOf(world({ own: false }), 'session_interrupt')),
      await refusal(confirmOf(world({ own: false, card: worker({ status: 'ended' }) }), 'session_kill')),
      await refusal(confirmOf(world({ own: false, card: worker({ status: 'ended' }) }), 'session_restart')),
      await refusal(confirmOf(world({ card: worker({ handsOff: true }) }), 'session_close')),
    ];
    for (const e of refusals) {
      expect(wordsOf(e)).not.toContain(ID);
      expect(wordsOf(e)).not.toContain('1a2b3c4d');
    }
  });
});

describe('the descriptions (Ruling 65)', () => {
  it('descriptions name the exemption and that a kill always asks', () => {
    const d = (name: EndTool): string => toolOf(name).description;
    expect(d('session_kill')).toMatch(/always asks/);
    expect(d('session_kill')).toMatch(/even your own idle worker/);
    expect(d('session_kill')).toMatch(/AASC ends a session only through its own terminal/);
    expect(d('session_kill')).not.toMatch(/process the session itself reported/);
    for (const name of ['session_restart', 'session_close'] as const) {
      expect(d(name), name).toMatch(/own idle worker/);
      expect(d(name), name).toMatch(/pinned/);
      expect(d(name), name).toMatch(/queued prompt switched on/);
    }
    expect(d('session_interrupt')).toMatch(/your own worker/);
    expect(d('session_interrupt')).toMatch(/dialog/);
    expect(d('session_interrupt')).toMatch(/task_cancel/);
    expect(d('session_restart')).toMatch(/no longer one of your own/);
    for (const name of TOOLS) {
      const text = d(name);
      expect(text, name).toMatch(/NEEDS_CONFIRMATION/);
      expect(text, name).toMatch(/confirm_wait/);
      expect(text, name).toMatch(/hands-off/);
      expect(text, name).toMatch(/another central/);
      expect(text, name).toMatch(/BUSY/);
      const tool = toolOf(name);
      expect(tool.risk, name).toBe('destructive');
      expect(tool.phase, name).toBe(5);
      expect(tool.toolset, name).toBe('sessions');
    }
  });
});

// ---------------------------------------------------------------------------
// Through the real gate (runTool.ts): an approval carried out on a different terminal runs nothing (P5-3)
// ---------------------------------------------------------------------------

describe('session_kill through the gate', () => {
  const macOpen = (): Answer =>
    ok({ ok: true, data: { devices: [{ clientId: 'mac-1', isLocal: true, connections: 1 }], workspaceWriter: 'mac-1' } });

  function gateWorld() {
    const registry = createCentralRegistry();
    const central = registry.mint(globalInput());
    const sessions: Session[] = [
      makeSession('card-1', { terminalId: 'term-card', central: { centralId: central.centralId, kind: 'global', scopeRef: null } }),
      worker(),
    ];
    const t = testDeliver({ sessions: () => sessions });
    const client = fakeClient({
      'GET /presence': macOpen(),
      [`POST /sessions/${ID}/kill`]: ok({ ok: true, killedPid: PID, terminalId: TERMINAL, processShared: false }),
    });
    const book = createConfirmBook();
    const kill = toolOf('session_kill');
    const deps: McpDeps = {
      registry,
      client: () => client,
      sessions: () => sessions,
      rooms: () => [],
      events: createEventHub(fakeBus().subscribe),
      now: () => NOW,
      deliver: t.deliver,
      confirms: book,
      tools: () => [kill, ...systemWriteTools],
    };
    const call = () => runTool(kill, { id: ID }, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' });
    const kills = () => client.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/kill'));
    return { sessions, book, call, kills };
  }

  it('kill after the terminal changed is INVALID, and nothing is killed', async () => {
    const g = gateWorld();
    const pending = g.call();
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(g.book.pending()).toHaveLength(1);

    g.sessions[1] = { ...g.sessions[1], terminalId: 'term-w2' };
    g.book.answer(g.book.pending()[0].cardId, 'allow');

    const e = await refusal(pending);
    expect(e.code).toBe('INVALID');
    expect(e.message).toBe('What you asked about changed after the person was asked, so nothing was done.');
    expect(g.kills()).toEqual([]);
  });

  it('a pin added after the allow is CHANGED, and nothing is killed', async () => {
    const g = gateWorld();
    const pending = g.call();
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    g.sessions[1] = { ...g.sessions[1], pinned: true };
    g.book.answer(g.book.pending()[0].cardId, 'allow');

    const e = await refusal(pending);
    expect(e.code).toBe('INVALID');
    expect(e.message).toBe('What you asked about changed after the person was asked, so nothing was done.');
    expect(g.kills()).toEqual([]);
  });

  it('an allowed kill of the same terminal runs once', async () => {
    const g = gateWorld();
    const pending = g.call();
    await vi.advanceTimersByTimeAsync(0);
    g.book.answer(g.book.pending()[0].cardId, 'allow');

    expect((await pending).data).toMatchObject({ sessionId: ID, killedPid: PID });
    expect(g.kills()).toHaveLength(1);
  });
});
