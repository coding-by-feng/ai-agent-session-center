// test/mcp/cleanup.test.ts — the idle clean-up (server/mcp/cleanup.ts): every 5 minutes AASC closes a central's own
// worker (workers.ts) that has sat idle for `mcp.idleWorkerMinutes` (30 by default; 0 = never), as its central, through
// DELETE /sessions/:id. Never one a person cares about (Ruling P4-11): pinned, hands-off, holding a task, adopted by a
// person, or with a queued prompt switched on; never a session no central opened. Fake timers and a fake /api client:
// nothing here reaches a terminal or a process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { ActivityInput } from '../../server/mcp/activity.js';
import { CLEANUP_EVERY_MS, startIdleCleanup, type CleanupDeps } from '../../server/mcp/cleanup.js';
import type { QueueItemLike } from '../../server/mcp/queueOps.js';
import { createWorkerRegistry, type WorkerController } from '../../server/mcp/workers.js';
import { fakeClient, makeCentral, makeSession, NOW, ok } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const MIN = 60_000;
const central = makeCentral('global', null, { centralId: 'central-1', terminalId: 'term-c' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A worker the central opened 40 minutes ago, idle for 31. */
const idleWorker = (id = 'w1', over: Partial<Session> = {}): Session =>
  makeSession(id, { terminalId: `t-${id}`, status: 'idle', lastActivityAt: NOW - 31 * MIN, ...over });

interface Setup {
  sessions?: Session[];
  /** Sessions the central opened (by id); every session given, by default. */
  own?: string[];
  minutes?: number;
  locked?: string[];
  queues?: Record<string, QueueItemLike[]>;
  controller?: (sessionId: string) => WorkerController | null;
}

function setup(o: Setup = {}) {
  const sessions = o.sessions ?? [idleWorker()];
  const workers = createWorkerRegistry({ controller: o.controller ?? (() => null) });
  for (const s of sessions) {
    if (o.own === undefined || o.own.includes(s.sessionId)) {
      workers.add({ centralId: central.centralId, terminalId: s.terminalId!, openedAt: NOW - 40 * MIN, folder: '/a/proj', cli: 'claude' });
    }
  }
  const api = fakeClient(Object.fromEntries(sessions.map((s) => [`DELETE /sessions/${s.sessionId}`, ok({ ok: true, removed: true })])));
  const clientFor = vi.fn(() => api);
  const rows: ActivityInput[] = [];
  const deps: CleanupDeps = {
    workers,
    sessions: () => sessions,
    centrals: { byId: (id) => (id === central.centralId ? central : null) },
    client: clientFor,
    ledger: { isLocked: (id) => (o.locked ?? []).includes(id) },
    queue: async () => ({ read: (id) => ({ items: o.queues?.[id] ?? [], automation: null }) }),
    activity: { logActivity: (row) => rows.push(row) as never },
    minutes: o.minutes ?? 30,
    now: () => Date.now(),
  };
  const cleanup = startIdleCleanup(deps);
  const deleted = () => api.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
  return { cleanup, workers, api, clientFor, rows, deleted };
}

const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(CLEANUP_EVERY_MS);
};

describe('the idle clean-up', () => {
  it('an idle own worker is closed after 30 min', async () => {
    const s = setup();

    await tick();

    expect(s.deleted()).toEqual(['/sessions/w1']);
    expect(s.clientFor).toHaveBeenCalledWith(expect.objectContaining({ centralId: central.centralId, token: '' }));
    expect(s.workers.of(central.centralId)).toEqual([]);
    expect(s.rows).toEqual([
      expect.objectContaining({ centralId: central.centralId, targetSessionId: 'w1', outcome: 'ok', summary: 'close #w1 (its own worker, idle 30 min)' }),
    ]);
    s.cleanup.close();
  });

  it('leaves a worker idle for less than the limit, or not idle', async () => {
    const s = setup({
      sessions: [idleWorker('w1', { lastActivityAt: NOW - 20 * MIN }), idleWorker('w2', { status: 'working' }), idleWorker('w3', { status: 'waiting' })],
    });

    await tick();

    expect(s.deleted()).toEqual(['/sessions/w3']);
    s.cleanup.close();
  });

  it('never closes a pinned worker', async () => {
    const s = setup({ sessions: [idleWorker('w1', { pinned: true })] });
    await tick();
    expect(s.deleted()).toEqual([]);
    s.cleanup.close();
  });

  it('never closes a hands-off worker', async () => {
    const s = setup({ sessions: [idleWorker('w1', { handsOff: true })] });
    await tick();
    expect(s.deleted()).toEqual([]);
    s.cleanup.close();
  });

  it('never closes a worker with an open task', async () => {
    const s = setup({ locked: ['w1'] });
    await tick();
    expect(s.deleted()).toEqual([]);
    s.cleanup.close();
  });

  it('never closes a worker a person adopted', async () => {
    const s = setup({ controller: (id) => (id === 'w1' ? { clientId: 'window-1', lastActivityAt: NOW - 35 * MIN, lastInputAt: NOW - 35 * MIN } : null) });
    await tick();
    expect(s.deleted()).toEqual([]);
    expect(s.workers.of(central.centralId)).toEqual([]);
    s.cleanup.close();
  });

  it('never closes a worker whose queue holds an enabled item', async () => {
    const s = setup({
      sessions: [idleWorker('w1'), idleWorker('w2')],
      queues: { w1: [{ id: 1, text: 'next', disabled: true }], w2: [{ id: 2, text: 'next' }] },
    });
    await tick();
    expect(s.deleted()).toEqual(['/sessions/w1']);
    s.cleanup.close();
  });

  it('0 turns clean-up off', async () => {
    const s = setup({ minutes: 0 });
    await tick();
    await tick();
    expect(s.deleted()).toEqual([]);
    expect(await s.cleanup.sweep()).toEqual([]);
    s.cleanup.close();
  });

  it("a person's session is never touched", async () => {
    const s = setup({ sessions: [idleWorker('mine'), idleWorker('persons', { lastActivityAt: NOW - 600 * MIN })], own: ['mine'] });
    await tick();
    expect(s.deleted()).toEqual(['/sessions/mine']);
    s.cleanup.close();
  });

  it('a worker given a task, or set working, while an earlier one was being closed stays open', async () => {
    const sessions = [idleWorker('w1'), idleWorker('w2'), idleWorker('w3')];
    const locked: string[] = [];
    const s = setup({ sessions, locked });
    const del = s.api.del;
    s.api.del = async (path, ...rest) => {
      // While w1 closes, a central hands w2 a task and a person's prompt sets w3 working.
      if (path === '/sessions/w1') {
        locked.push('w2');
        sessions[2] = { ...sessions[2], status: 'working', lastActivityAt: Date.now() };
      }
      return del(path, ...rest);
    };

    expect(await s.cleanup.sweep()).toEqual(['w1']);
    expect(s.deleted()).toEqual(['/sessions/w1']);
    expect(s.workers.of(central.centralId).map((w) => w.terminalId)).toEqual(['t-w2', 't-w3']);
    s.cleanup.close();
  });

  it('a worker that is no longer its central’s own by its turn stays open', async () => {
    const sessions = [idleWorker('w1'), idleWorker('w2')];
    const s = setup({ sessions });
    const del = s.api.del;
    s.api.del = async (path, ...rest) => {
      if (path === '/sessions/w1') s.workers.release('t-w2', 'adopted');
      return del(path, ...rest);
    };

    expect(await s.cleanup.sweep()).toEqual(['w1']);
    expect(s.deleted()).toEqual(['/sessions/w1']);
    s.cleanup.close();
  });

  it('a never-started worker is closed though its card says idle', async () => {
    // NEW_WORKER_START_MS (120 s) + 60 s: its task has failed by then, and it holds one of the central's 8 slots. The
    // connecting timeout flipped its card to idle at 30 s with no hook (`startHeard: false`), so its status says nothing.
    const stuck = idleWorker('stuck', { startHeard: false, startedAt: NOW - 181_000, lastActivityAt: NOW - 181_000 });
    const young = idleWorker('young', { startHeard: false, startedAt: NOW - 170_000, lastActivityAt: NOW - 170_000 });
    const heard = idleWorker('heard', { startedAt: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN });
    const held = idleWorker('held', { startHeard: false, startedAt: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN });
    const pinned = idleWorker('pinned', { startHeard: false, startedAt: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN, pinned: true });
    const handsOff = idleWorker('hands', { startHeard: false, startedAt: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN, handsOff: true });
    const persons = idleWorker('persons', { startHeard: false, startedAt: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN });
    const s = setup({
      sessions: [stuck, young, heard, held, pinned, handsOff, persons],
      locked: ['held'],
      own: ['stuck', 'young', 'heard', 'held', 'pinned', 'hands'],
    });

    expect(await s.cleanup.sweep()).toEqual(['stuck']);
    expect(s.deleted()).toEqual(['/sessions/stuck']);
    expect(s.rows).toEqual([
      expect.objectContaining({ targetSessionId: 'stuck', outcome: 'ok', summary: 'close #stuck (its own worker, never started)' }),
    ]);
    s.cleanup.close();
  });

  it('clean-up never closes a worker that is only unheard since a restart', async () => {
    // Ruling P4-58: after an AASC restart a surviving worker's terminal is unheard until its next hook (no marker). The
    // never-started rule reads the marker only, so the restart alone never closes it; idle time still does.
    const survivor = idleWorker('surv', { startedAt: NOW - 10 * MIN, lastActivityAt: NOW - 10 * MIN });
    const s = setup({ sessions: [survivor] });

    expect(await s.cleanup.sweep()).toEqual([]);
    expect(s.deleted()).toEqual([]);
    s.cleanup.close();
  });

  it('with idle clean-up off a never-started worker is still closed', async () => {
    const stuck = idleWorker('stuck', { startHeard: false, startedAt: NOW - 181_000, lastActivityAt: NOW - 181_000 });
    const idle = idleWorker('idle');
    const s = setup({ sessions: [stuck, idle], minutes: 0 });

    // The timer runs too, not only a hand-called sweep.
    await tick();

    expect(s.deleted()).toEqual(['/sessions/stuck']);
    s.cleanup.close();
  });

  it('keeps a worker it could not close as its own, and stops when closed', async () => {
    const s = setup();
    s.api.calls.length = 0;
    const failing = setup({ sessions: [idleWorker('w9')] });
    failing.api.del = async () => ({ ok: false, status: 409, data: { error: 'restarting' }, error: 'restarting' });

    await tick();
    expect(failing.workers.of(central.centralId)).toHaveLength(1);
    expect(failing.rows).toEqual([]);

    s.cleanup.close();
    failing.cleanup.close();
    const later = setup();
    later.cleanup.close();
    await tick();
    expect(later.deleted()).toEqual([]);
  });
});
