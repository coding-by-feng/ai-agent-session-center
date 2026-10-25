// test/mcp/scopePredicate.test.ts — the ONE scope rule a call runs with (ToolContext.inScope, built in
// server/mcp/callContext.ts): rooms plus the workers the central opened itself, filed into its room yet or not
// (server/mcp/workers.ts, by terminal), used alike by scopedSessions, resolveTarget and session_wait's matcher; and
// resolveTarget following a re-keyed or restored id to the session it names now (ToolContext.resolveSessionId).
import { describe, expect, it, vi } from 'vitest';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import { contextFor, neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry, type MintInput } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { resolveTarget } from '../../server/mcp/tools/define.js';
import { ToolError } from '../../server/mcp/types.js';
import { createWorkerRegistry, workers as serverWorkers, type OwnWorker } from '../../server/mcp/workers.js';
import { fakeBus, globalInput, roomInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { fakeClient, makeRoom, makeSession, NOW, run } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

interface WorldOptions {
  input?: MintInput;
  sessions?: Session[];
  rooms?: Room[];
  deps?: Partial<McpDeps>;
}

/** A worker `centralId` opened in terminal `terminalId`. */
const opened = (centralId: string, terminalId: string): OwnWorker => ({
  centralId,
  terminalId,
  openedAt: NOW - 60_000,
  folder: '/a/proj',
  cli: 'claude',
});

function world(opts: WorldOptions = {}) {
  const registry = createCentralRegistry();
  const central = registry.mint(opts.input ?? roomInput('r1'));
  const bus = fakeBus();
  const own = createWorkerRegistry({ controller: () => null });
  const sessions = opts.sessions ?? [
    makeSession('member-1', { terminalId: 'term-m1' }),
    makeSession('worker-1', { terminalId: 'term-w1' }),
    makeSession('outsider', { terminalId: 'term-o1' }),
  ];
  const rooms = opts.rooms ?? [makeRoom('r1', ['member-1']), makeRoom('r2', ['outsider'])];
  const deps: McpDeps = {
    registry,
    client: () => fakeClient(),
    sessions: () => sessions,
    rooms: () => rooms,
    events: createEventHub(bus.subscribe),
    now: () => NOW,
    workers: own,
    ...opts.deps,
  };
  const ctx = () => contextFor(central.centralId, deps, neverAborted);
  return { registry, central, bus, own, sessions, rooms, deps, ctx };
}

const refusedCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
  throw new Error('expected a ToolError');
};

describe('ToolContext.inScope', () => {
  it('is the rule scopedSessions applies: a room’s members plus its central’s own workers', () => {
    const w = world();
    w.own.add(opened(w.central.centralId, 'term-w1'));
    const ctx = w.ctx();

    expect(ctx.scopedSessions().map((s) => s.sessionId)).toEqual(['member-1', 'worker-1']);
    expect(w.sessions.map((s) => ctx.inScope(s))).toEqual([true, true, false]);
  });

  it("a room central's scope includes its own unfiled worker", () => {
    const w = world({
      sessions: [makeSession('member-1', { terminalId: 'term-m1' }), makeSession('cli-abc', { terminalId: 'term-w1' })],
    });
    w.own.add(opened(w.central.centralId, 'term-w1'));
    const ctx = w.ctx();

    // No room lists it (the window has not filed it, or is closed): the terminal makes it the central's own, under the
    // id the CLI gave the card.
    expect(w.rooms.some((r) => r.sessionIds.includes('cli-abc'))).toBe(false);
    expect(ctx.inScope(w.sessions[1])).toBe(true);
    expect(resolveTarget(ctx, 'cli-abc').sessionId).toBe('cli-abc');
    // It widens the room by itself and nothing else: another room's session is still out.
    expect(ctx.inScope(makeSession('outsider', { terminalId: 'term-o1' }))).toBe(false);

    w.own.release('term-w1', 'exited');
    expect(ctx.inScope(w.sessions[1])).toBe(false);
  });

  it('counts another central’s own workers for nothing', () => {
    const w = world();
    w.own.add(opened('some-other-central', 'term-w1'));
    const ctx = w.ctx();

    expect(ctx.inScope(w.sessions[1])).toBe(false);
    expect(ctx.scopedSessions().map((s) => s.sessionId)).toEqual(['member-1']);
    expect(ctx.workers.isOwn('some-other-central', w.sessions[1])).toBe(false);
  });

  it('reads the rooms and the own workers as they are at each check, not when the call began', () => {
    const w = world();
    const ctx = w.ctx();
    expect(ctx.inScope(w.sessions[1])).toBe(false);

    w.own.add(opened(w.central.centralId, 'term-w1'));
    expect(ctx.inScope(w.sessions[1])).toBe(true);
    w.rooms[0] = makeRoom('r1', []);
    expect(ctx.inScope(w.sessions[0])).toBe(false);
  });

  it('uses the server’s own registry when the deps name none', () => {
    const w = world({ deps: { workers: undefined } });
    serverWorkers.add(opened(w.central.centralId, 'term-w1'));
    try {
      expect(w.ctx().inScope(w.sessions[1])).toBe(true);
      expect(w.ctx().workers.of(w.central.centralId)).toHaveLength(1);
    } finally {
      serverWorkers.release('term-w1', 'closed');
    }
  });
});

describe('resolveTarget follows the one rule', () => {
  it('resolves an own worker of a room central, and refuses a session of another room', () => {
    const w = world();
    w.own.add(opened(w.central.centralId, 'term-w1'));
    const ctx = w.ctx();

    expect(resolveTarget(ctx, 'worker-1').sessionId).toBe('worker-1');
    expect(refusedCode(() => resolveTarget(ctx, 'outsider'))).toBe('NOT_IN_SCOPE');
  });

  it('asks ctx.inScope, not a list of its own', () => {
    const w = world();
    const ctx = { ...w.ctx(), inScope: (s: Session) => s.sessionId === 'outsider' };

    expect(resolveTarget(ctx, 'outsider').sessionId).toBe('outsider');
    expect(refusedCode(() => resolveTarget(ctx, 'member-1'))).toBe('NOT_IN_SCOPE');
  });

  it('lists only candidates in scope for a prefix that starts several', () => {
    const w = world({
      input: globalInput(),
      sessions: [makeSession('abcdef-1'), makeSession('abcdef-2'), makeSession('abcdef-3')],
    });
    const ctx = { ...w.ctx(), inScope: (s: Session) => s.sessionId !== 'abcdef-3' };

    try {
      resolveTarget(ctx, 'abcdef');
    } catch (err) {
      expect(err).toMatchObject({ code: 'INVALID' });
      expect((err as ToolError).hint).toContain('abcdef-1');
      expect((err as ToolError).hint).toContain('abcdef-2');
      expect((err as ToolError).hint).not.toContain('abcdef-3');
      return;
    }
    throw new Error('expected INVALID');
  });
});

describe('resolveTarget follows session aliases', () => {
  const aliased = (input: MintInput = globalInput()) => {
    const { deliver } = testDeliver({ aliases: { 'term-old': 'term-mid', 'term-mid': 'uuid-now' } });
    return world({
      input,
      sessions: [makeSession('uuid-now', { terminalId: 'term-9' }), makeSession('other', { terminalId: 'term-8' })],
      rooms: [makeRoom('r1', ['uuid-now'])],
      deps: { deliver },
    });
  };

  it('takes a re-keyed or restored id to the session it names now, through the whole chain', () => {
    const ctx = aliased().ctx();

    expect(resolveTarget(ctx, 'term-old').sessionId).toBe('uuid-now');
    expect(resolveTarget(ctx, 'term-mid').sessionId).toBe('uuid-now');
    expect(resolveTarget(ctx, 'uuid-now').sessionId).toBe('uuid-now');
  });

  it('still holds the session to the scope rule', () => {
    const w = aliased(roomInput('r2'));
    expect(refusedCode(() => resolveTarget(w.ctx(), 'term-old'))).toBe('NOT_IN_SCOPE');
  });

  it('is NOT_FOUND for an alias that leads nowhere, and falls back to a prefix for anything else', () => {
    const { deliver } = testDeliver({ aliases: { 'term-gone': 'uuid-missing' } });
    const w = world({ input: globalInput(), sessions: [makeSession('uuid-now')], deps: { deliver } });
    const ctx = w.ctx();

    expect(refusedCode(() => resolveTarget(ctx, 'term-gone'))).toBe('NOT_FOUND');
    expect(resolveTarget(ctx, 'uuid-n').sessionId).toBe('uuid-now');
  });

  it('knows only exact ids when AASC’s alias map is not wired', () => {
    const w = world({ input: globalInput(), sessions: [makeSession('uuid-now')] });
    const ctx = w.ctx();

    expect(ctx.resolveSessionId('uuid-now')).toBe('uuid-now');
    expect(ctx.resolveSessionId('term-old')).toBeNull();
  });
});

describe('session_wait’s matcher follows the one rule', () => {
  it('reports an own worker’s update to a room central', async () => {
    const w = world();
    w.own.add(opened(w.central.centralId, 'term-w1'));
    const ctx = w.ctx();

    const waiting = run('session_wait', { ids: ['worker-1'], until: 'waiting', ignoreCurrent: true, timeoutSeconds: 5 }, ctx);
    await vi.waitFor(() => expect(w.bus.listenerCount()).toBe(1));
    w.bus.emit({ type: 'session_update', session: { ...w.sessions[1], status: 'waiting' } });
    const result = await waiting;

    expect(result.data).toMatchObject({ timedOut: false, how: 'update' });
  });

  it('stops reporting a worker the moment it is no longer the central’s own', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      w.own.add(opened(w.central.centralId, 'term-w1'));
      const ctx = w.ctx();

      const waiting = run('session_wait', { ids: ['worker-1'], until: 'waiting', ignoreCurrent: true, timeoutSeconds: 2 }, ctx);
      await vi.waitFor(() => expect(w.bus.listenerCount()).toBe(1));
      w.own.release('term-w1', 'exited');
      w.bus.emit({ type: 'session_update', session: { ...w.sessions[1], status: 'waiting' } });
      await vi.advanceTimersByTimeAsync(2_100);
      const result = await waiting;

      expect(result.data).toMatchObject({ timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
