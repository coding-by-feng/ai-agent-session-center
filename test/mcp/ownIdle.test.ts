// test/mcp/ownIdle.test.ts — the own-idle-worker rule (server/mcp/ownIdle.ts, Ruling P5-4): when restarting or closing
// a session needs no card. Only the caller's own worker that a person has not adopted, not pinned, not hands-off, holding
// no task, idle or waiting, with nothing switched on in a queue that can be read. Every other case names its reason.
// Pure: no route, no terminal, no process.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { unwiredLedger } from '../../server/mcp/deliver.js';
import { keptByPerson, ownIdleReason } from '../../server/mcp/ownIdle.js';
import type { QueueItemLike } from '../../server/mcp/queueOps.js';
import { createWorkerRegistry, workersFor, type WorkerController } from '../../server/mcp/workers.js';
import { makeCentral, makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const OPENED_AT = 5_000;

interface WorldOptions {
  locked?: string[];
  controller?: (sessionId: string) => WorkerController | null;
}

/** The central `central-1` with its own worker in term-w1 (and another central's in term-w9). */
function world(o: WorldOptions = {}) {
  const central = makeCentral();
  const registry = createWorkerRegistry({ controller: o.controller ?? (() => null) });
  registry.add({ centralId: central.centralId, terminalId: 'term-w1', openedAt: OPENED_AT, folder: '/a/proj', cli: 'claude' });
  registry.add({ centralId: 'central-9', terminalId: 'term-w9', openedAt: OPENED_AT, folder: '/a/proj', cli: 'claude' });
  const locked = new Set(o.locked ?? []);
  const ctx = {
    central,
    workers: workersFor(registry, central.centralId),
    ledger: { ...unwiredLedger, isLocked: (id: string) => locked.has(id) },
  };
  return { ctx, registry };
}

const own = (over: Partial<Session> = {}): Session => makeSession('w1', { terminalId: 'term-w1', status: 'idle', ...over });
const queueOf =
  (items: QueueItemLike[]) =>
  async (): Promise<readonly QueueItemLike[]> =>
    items;
const emptyQueue = queueOf([]);

describe('ownIdleReason', () => {
  it('ownIdleReason is null for an own idle worker with an empty queue', async () => {
    const { ctx } = world();

    expect(await ownIdleReason(ctx, own(), emptyQueue)).toBeNull();
    expect(await ownIdleReason(ctx, own({ status: 'waiting' }), emptyQueue)).toBeNull();
    // Prompts the person switched off are no queued work.
    expect(await ownIdleReason(ctx, own(), queueOf([{ id: 'q1', disabled: true }]))).toBeNull();
  });

  it('not own, pinned, hands-off, a task, working, an enabled queue prompt and an unreadable queue each need a card', async () => {
    const { ctx } = world({ locked: ['w1-locked'] });
    const unreadable = async (): Promise<readonly QueueItemLike[]> => {
      throw new Error('queue store not loaded');
    };
    const cases: Array<[string, Session, (id: string) => Promise<readonly QueueItemLike[]>]> = [
      ['not-own', makeSession('p1', { terminalId: 'term-person', status: 'idle' }), emptyQueue],
      ['not-own', makeSession('w9', { terminalId: 'term-w9', status: 'idle' }), emptyQueue],
      ['pinned', own({ pinned: true }), emptyQueue],
      ['hands-off', own({ handsOff: true }), emptyQueue],
      ['a task', own({ sessionId: 'w1-locked' }), emptyQueue],
      ['not-idle', own({ status: 'working' }), emptyQueue],
      ['not-idle', own({ status: 'connecting' }), emptyQueue],
      ['not-idle', own({ status: 'ended' }), emptyQueue],
      ['queued-work', own(), queueOf([{ id: 'q1', disabled: true }, { id: 'q2' }])],
      ['queue-unreadable', own(), unreadable],
    ];
    for (const [reason, s, readQueue] of cases) {
      expect(await ownIdleReason(ctx, s, readQueue), `${reason} ${s.sessionId} ${s.status}`).toBe(reason);
    }
  });

  it('a worker the person typed into needs a card', async () => {
    const typed = world({ controller: () => ({ clientId: 'browser-1', lastActivityAt: OPENED_AT + 10, lastInputAt: OPENED_AT + 10 }) });
    expect(await ownIdleReason(typed.ctx, own(), emptyQueue)).toBe('not-own');

    // A resize or a clear moves the baton but is not input; a central's own presence is no person.
    const resized = world({ controller: () => ({ clientId: 'browser-1', lastActivityAt: OPENED_AT + 10 }) });
    expect(await ownIdleReason(resized.ctx, own(), emptyQueue)).toBeNull();
    const central = world({ controller: () => ({ clientId: 'mcp:central-1', lastActivityAt: OPENED_AT + 10, lastInputAt: OPENED_AT + 10 }) });
    expect(await ownIdleReason(central.ctx, own(), emptyQueue)).toBeNull();
  });

  it('a pinned own worker needs a card, before its queue is read', async () => {
    const { ctx } = world();
    const readQueue = vi.fn(emptyQueue);

    expect(await ownIdleReason(ctx, own({ pinned: true, handsOff: true }), readQueue)).toBe('pinned');
    expect(readQueue).not.toHaveBeenCalled();
  });

  it('reads the queue of the session it was given', async () => {
    const { ctx } = world();
    const readQueue = vi.fn(emptyQueue);

    await ownIdleReason(ctx, own(), readQueue);

    expect(readQueue).toHaveBeenCalledWith('w1');
  });
});

describe('keptByPerson', () => {
  it('pinned, then hands-off, then a task, else null', () => {
    const ledger = { isLocked: (id: string) => id === 'locked' };

    expect(keptByPerson(own({ pinned: true, handsOff: true }), ledger)).toBe('pinned');
    expect(keptByPerson(own({ handsOff: true, sessionId: 'locked' }), ledger)).toBe('hands-off');
    expect(keptByPerson(own({ sessionId: 'locked' }), ledger)).toBe('a task');
    expect(keptByPerson(own(), ledger)).toBeNull();
  });
});
