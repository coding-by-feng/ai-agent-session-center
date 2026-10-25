// test/mcp/deliver.test.ts — the P2 runtime a call's context is built on (server/mcp/deliver.ts, callContext.ts):
// the ledger seen as one central, `mayDrive` bound to live presence and the lock, task changes written to the
// activity log and announced token-free, and what a context does when none of it is wired (it refuses).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import type { McpTaskView } from '../../src/types/mcpEvents.js';
import { contextFor, neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry, type MintInput } from '../../server/mcp/centrals.js';
import { toTaskView } from '../../server/mcp/deliver.js';
import { createEventHub } from '../../server/mcp/events.js';
import { STOP_SETTLE_MS } from '../../server/mcp/ledger.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { ToolError } from '../../server/mcp/types.js';
import { fakeBus, globalInput, roomInput } from './centralFixtures.js';
import { testDeliver, type TestDeliverOptions } from './deliverFixtures.js';
import { fakeClient, makeRoom, makeSession, NOW } from './toolHarness.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

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

interface Built {
  sessions: Session[];
  rooms: Room[];
  deps: McpDeps;
  t: ReturnType<typeof testDeliver>;
  registry: ReturnType<typeof createCentralRegistry>;
  ctxOf(centralId: string): ReturnType<typeof contextFor>;
}

function build(opts: { wired?: boolean; deliver?: TestDeliverOptions } = {}): Built {
  const registry = createCentralRegistry();
  const sessions: Session[] = [
    makeSession('w1', { terminalId: 'term-w1', status: 'waiting' }),
    makeSession('w2', { terminalId: 'term-w2', status: 'waiting', opsTerminalId: 'term-ops' }),
    makeSession('ops-card', { terminalId: 'term-ops', status: 'waiting' }),
  ];
  const rooms = [makeRoom('r1', ['w1', 'w2', 'ops-card'], 'Backend')];
  const t = testDeliver({ sessions: () => sessions, ...opts.deliver });
  // The ledger's fake deps look sessions up in their own table: give it the same workers.
  for (const s of sessions) t.ledgerDeps.setSession(s);
  const deps: McpDeps = {
    registry,
    client: () => fakeClient(),
    sessions: () => sessions,
    rooms: () => rooms,
    events: createEventHub(fakeBus().subscribe),
    now: () => Date.now(),
    ...(opts.wired === false ? {} : { deliver: t.deliver }),
  };
  return { sessions, rooms, deps, t, registry, ctxOf: (id) => contextFor(id, deps, neverAborted) };
}

const mint = (b: Built, input: MintInput) => b.registry.mint(input);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
  throw new Error('a ToolError was expected');
}

async function asyncCodeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
  throw new Error('a ToolError was expected');
}

describe('the context’s P2 members', () => {
  it('are inScope, resolveSessionId, ledger and mayDrive, beside the P1 ones (and P4’s workers)', () => {
    const b = build();
    const c = mint(b, globalInput());

    expect(Object.keys(b.ctxOf(c.centralId)).sort()).toEqual([
      'allowedByPerson',
      'central',
      'centrals',
      'client',
      'confirms',
      'events',
      'inScope',
      'ledger',
      'mayDrive',
      'mayEdit',
      'mayEnd',
      'mayRelaunch',
      'now',
      'resolveSessionId',
      'rooms',
      'scopedSessions',
      'sessions',
      'signal',
      'workers',
    ]);
  });
});

describe('ctx.ledger: the shared ledger, seen as one central', () => {
  it('shows a central only its own tasks, while the lock spans every central', async () => {
    const b = build();
    const one = mint(b, globalInput());
    const two = mint(b, roomInput('r1'));
    const ctx1 = b.ctxOf(one.centralId);
    const ctx2 = b.ctxOf(two.centralId);
    const w1 = b.sessions[0];

    const task = ctx1.ledger.create({ central: ctx1.central, session: w1, task: 'one' });
    await flush();

    expect(ctx1.ledger.get(task.taskId)?.taskId).toBe(task.taskId);
    expect(ctx2.ledger.get(task.taskId)).toBeNull();
    expect(ctx2.ledger.list()).toEqual([]);
    expect(ctx2.ledger.list({ centralId: one.centralId })).toEqual([]);
    expect(await ctx2.ledger.wait([task.taskId], 0)).toEqual([]);
    expect(await asyncCodeOf(ctx2.ledger.cancel(task.taskId, one.centralId))).toBe('NOT_FOUND');

    expect(ctx2.ledger.isLocked('w1')).toBe(true);
    expect(codeOf(() => ctx2.ledger.create({ central: ctx2.central, session: w1, task: 'two' }))).toBe('BUSY');
  });

  it('records tasks as its own central only', () => {
    const b = build();
    const one = mint(b, globalInput());
    const two = mint(b, roomInput('r1'));
    const ctx1 = b.ctxOf(one.centralId);

    expect(codeOf(() => ctx1.ledger.create({ central: b.ctxOf(two.centralId).central, session: b.sessions[0], task: 'x' }))).toBe(
      'INVALID',
    );
  });

  it('labels the envelope with the room central’s room name', () => {
    const b = build();
    const room = mint(b, roomInput('r1'));
    const ctx = b.ctxOf(room.centralId);

    ctx.ledger.create({ central: ctx.central, session: b.sessions[0], task: 'review the diff' });

    expect(b.t.ledgerDeps.submits[0].text.startsWith('[AASC · task T1 from ★ room "Backend"] review the diff')).toBe(true);
  });
});

describe('ctx.mayDrive', () => {
  it('lets an in-scope worker through, and refuses with the policy’s codes', async () => {
    const b = build({
      deliver: { controller: (id) => (id === 'w2' ? { clientId: 'desktop-1', lastActivityAt: Date.now() - 5_000 } : null) },
    });
    const c = mint(b, globalInput());
    const ctx = b.ctxOf(c.centralId);

    expect(() => ctx.mayDrive(b.sessions[0])).not.toThrow();
    expect(codeOf(() => ctx.mayDrive(b.sessions[1]))).toBe('HUMAN_ACTIVE');

    ctx.ledger.create({ central: ctx.central, session: b.sessions[0], task: 'x' });
    expect(codeOf(() => ctx.mayDrive(b.sessions[0]))).toBe('BUSY');
  });

  it('knows a session’s ops shell from the cards, as well as from the runtime', () => {
    const b = build();
    const c = mint(b, globalInput());

    expect(codeOf(() => b.ctxOf(c.centralId).mayDrive(b.sessions[2]))).toBe('INVALID');
  });

  it('holds a room central to its room', () => {
    const b = build();
    b.rooms.push(makeRoom('r2', ['elsewhere'], 'Docs'));
    b.sessions.push(makeSession('elsewhere', { terminalId: 'term-e', status: 'waiting' }));
    const c = mint(b, roomInput('r1'));

    expect(codeOf(() => b.ctxOf(c.centralId).mayDrive(b.sessions[3]))).toBe('NOT_IN_SCOPE');
  });

  it('logs each refusal to the activity log when the call is a tool’s (runTool does that; a bare context does not)', () => {
    const b = build({ deliver: { controller: () => ({ clientId: 'phone-1', lastActivityAt: Date.now() }) } });
    const c = mint(b, globalInput());

    expect(codeOf(() => b.ctxOf(c.centralId).mayDrive(b.sessions[0]))).toBe('HUMAN_ACTIVE');
    expect(b.t.activity.listActivity()).toEqual([]);
  });
});

describe('task changes', () => {
  it('are written to the activity log, one row per change of state', async () => {
    const b = build();
    const c = mint(b, globalInput());
    const card = makeSession('card-c', { central: { centralId: c.centralId, kind: 'global', scopeRef: null } });
    b.sessions.push(card);
    const ctx = b.ctxOf(c.centralId);

    const task = ctx.ledger.create({ central: ctx.central, session: b.sessions[0], task: 'fix the flaky test' });
    await flush();
    b.t.ledgerDeps.takePrompt('w1');
    b.t.ledgerDeps.answers.set('w1', 'Fixed it.');
    b.t.ledgerDeps.hook('Stop', 'w1', { status: 'waiting', backgroundTaskCount: 0 });
    await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS + 10);

    const rows = b.t.activity.listActivity().reverse();
    expect(rows.map((r) => r.outcome)).toEqual(['queued', 'sent', 'running', 'done']);
    for (const row of rows) {
      expect(row).toMatchObject({
        centralId: c.centralId,
        centralSessionId: 'card-c',
        tool: 'task',
        risk: 'steers',
        targetSessionId: 'w1',
        taskId: task.taskId,
      });
    }
    // The rows say what happened, never what was asked or answered.
    expect(JSON.stringify(rows)).not.toMatch(/flaky|Fixed it/);
  });

  it('write no row for a change that moves no state (the worker re-keyed)', async () => {
    const b = build();
    const c = mint(b, globalInput());
    const ctx = b.ctxOf(c.centralId);

    const task = ctx.ledger.create({ central: ctx.central, session: b.sessions[0], task: 'x' });
    await flush();
    b.t.ledgerDeps.takePrompt('w1');
    b.t.ledgerDeps.rekey('w1', 'uuid-1');
    b.t.ledgerDeps.hook('PreToolUse', 'uuid-1', { status: 'working' });

    expect(b.t.ledger.get(task.taskId)?.sessionId).toBe('uuid-1');
    expect(b.t.activity.listActivity().map((r) => r.outcome)).toEqual(['running', 'sent', 'queued']);
  });

  it('are announced to onTaskUpdate listeners token-free, without the answer or the prompt key', async () => {
    const b = build();
    const c = mint(b, globalInput());
    const ctx = b.ctxOf(c.centralId);
    const heard: McpTaskView[] = [];
    const off = b.t.deliver.onTaskUpdate((view) => heard.push(view));

    const task = ctx.ledger.create({
      central: ctx.central,
      session: b.sessions[0],
      task: `fix the test\nwith the key aasc_mcp_${'A'.repeat(43)} please`,
    });
    await flush();
    off();
    b.t.ledgerDeps.takePrompt('w1');

    expect(heard.map((v) => v.state)).toEqual(['queued', 'sent']);
    expect(heard[1]).toEqual({
      taskId: task.taskId,
      centralId: c.centralId,
      sessionId: 'w1',
      state: 'sent',
      title: expect.stringContaining('fix the test with the key'),
      createdAt: NOW,
      sentAt: NOW,
      updatedAt: NOW,
      error: null,
      answerChars: null,
      answerTruncated: false,
      route: null,
      retargetedFrom: null,
    });
    const text = JSON.stringify(heard);
    expect(text).not.toContain('A'.repeat(43));
    expect(text).not.toContain(task.promptKey);
  });

  it('a view of a finished task counts its answer, and never carries it', () => {
    const view = toTaskView({
      taskId: 'T1',
      centralId: 'c1',
      sessionId: 'w1',
      terminalId: 'term-w1',
      task: 'x'.repeat(500),
      answerFormat: null,
      state: 'done',
      createdAt: 1,
      sentAt: 2,
      updatedAt: 3,
      promptKey: 'mcp-c1-task-T1',
      answer: '<untrusted source="session:w1" kind="answer">the answer</untrusted>',
      answerTruncated: true,
      error: null,
      history: [],
    });

    // The length of what the session wrote, not of its fence; and whether it was cut (Ruling 48).
    expect(view.answerChars).toBe('the answer'.length);
    expect(view.answerTruncated).toBe(true);
    expect(view.title.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(view)).not.toContain('the answer');
    expect(Object.keys(view)).not.toContain('terminalId');
  });
});

describe('when the P2 runtime is not wired', () => {
  it('a context still reads, but its ledger and mayDrive refuse with UNAVAILABLE', async () => {
    const b = build({ wired: false });
    const c = mint(b, globalInput());
    const ctx = b.ctxOf(c.centralId);

    expect(ctx.scopedSessions().map((s) => s.sessionId)).toEqual(['w1', 'w2', 'ops-card']);
    expect(codeOf(() => ctx.mayDrive(b.sessions[0]))).toBe('UNAVAILABLE');
    expect(codeOf(() => ctx.ledger.create({ central: ctx.central, session: b.sessions[0], task: 'x' }))).toBe('UNAVAILABLE');
    expect(ctx.ledger.list()).toEqual([]);
    expect(ctx.ledger.get('T1')).toBeNull();
    expect(ctx.ledger.isLocked('w1')).toBe(false);
    expect(await ctx.ledger.wait(['T1'], 10_000)).toEqual([]);
    expect(await asyncCodeOf(ctx.ledger.cancel('T1', c.centralId))).toBe('NOT_FOUND');
  });
});
