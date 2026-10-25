// test/mcp/centralRun.test.ts — stopping the run a central left in its own worker's queue (server/mcp/centralRun.ts,
// Rulings P4-25 and P4-30): when the central is revoked (workers.ts releaseCentral, through wireWorkerReleases) and when
// the person turns hands-off on for that worker (handsOffSetter.ts), which also releases it. The queue's items stay;
// automation is paused with auto-resume off, the way queue_pause writes it, and one activity row says so. A person's
// own session is untouched. The queue store and the activity log are in-memory stand-ins.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { ActivityInput } from '../../server/mcp/activity.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import {
  CENTRAL_RUN_ORIGIN,
  handsOffTurnedOn,
  onHandsOffTurnedOn,
  releaseOnHandsOff,
  stopCentralRun,
  type CentralRunDeps,
} from '../../server/mcp/centralRun.js';
import { createHandsOffSetter } from '../../server/mcp/handsOffSetter.js';
import type { QueueAutomationLike, QueueItemLike, QueueStore } from '../../server/mcp/queueOps.js';
import { createWorkerRegistry, wireWorkerReleases } from '../../server/mcp/workers.js';
import { fakeTerminalExits, globalInput } from './centralFixtures.js';
import { makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const AUTOMATION = {
  paused: false,
  autoSend: true,
  autoEnter: true,
  idleGuard: true,
  skipWhenPrompting: false,
  autoResume: true,
  resumeMaxRetries: 3,
  resumePrompt: '',
};
const ITEMS: QueueItemLike[] = [{ id: 1, text: 'run the tests' }, { id: 2, text: 'then the lint', disabled: true }];

interface Row {
  items: QueueItemLike[];
  automation: QueueAutomationLike | null;
}

function fakeQueues(initial: Record<string, Row> = {}) {
  const rows = new Map<string, Row>(Object.entries(initial));
  const writes: Array<{ sessionId: string; items: QueueItemLike[]; automation: QueueAutomationLike | null; origin: string }> = [];
  const store: QueueStore = {
    read: (sessionId) => {
      const row = rows.get(sessionId);
      return row ? { items: [...row.items], automation: row.automation } : { items: [], automation: null };
    },
    write: (sessionId, items, automation, origin) => {
      writes.push({ sessionId, items, automation, origin });
      rows.set(sessionId, { items, automation });
    },
  };
  return { store, rows, writes };
}

function world(cards: Session[], queues: Record<string, Row>) {
  const q = fakeQueues(queues);
  const rows: ActivityInput[] = [];
  const deps: CentralRunDeps = {
    queue: async () => q.store,
    activity: { logActivity: (input) => rows.push(input) as never },
    cardIn: (terminalId) => cards.find((s) => s.terminalId === terminalId && s.status !== 'ended') ?? null,
    centralSessionOf: () => 'card-central',
    now: () => 1_000,
  };
  return { q, rows, deps };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('stopCentralRun (Rulings P4-25, P4-30)', () => {
  it("a revoked central's own worker queue is paused", async () => {
    const workers = createWorkerRegistry({ controller: () => null });
    const centrals = createCentralRegistry();
    const central = centrals.mint(globalInput());
    const card = makeSession('w1', { terminalId: 'term-w1', status: 'waiting' });
    const { q, rows, deps } = world([card], { w1: { items: ITEMS, automation: AUTOMATION } });
    wireWorkerReleases(workers, {
      onTerminalExit: fakeTerminalExits().subscribe,
      centrals,
      onRevoked: (released) => {
        for (const w of released) void stopCentralRun(w.terminalId, { centralId: w.centralId, reason: 'revoked' }, deps);
      },
    });
    workers.add({ centralId: central.centralId, terminalId: 'term-w1', openedAt: 0, folder: '/a', cli: 'claude' });

    centrals.revoke(central.centralId);
    await flush();

    expect(q.writes).toHaveLength(1);
    expect(q.writes[0]).toMatchObject({ sessionId: 'w1', origin: CENTRAL_RUN_ORIGIN });
    expect(q.writes[0].automation).toMatchObject({ ...AUTOMATION, paused: true, autoResume: false });
    // The items stay as they were: the person resumes them.
    expect(q.writes[0].items).toEqual(ITEMS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ centralId: central.centralId, targetSessionId: 'w1', outcome: 'ok', risk: 'write' });
    expect(rows[0].summary).toMatch(/paused the queue of #w1/);
    expect(rows[0].summary).toMatch(/revoked/);
  });

  it('leaves a queue alone that runs nothing, or is paused already', async () => {
    const card = makeSession('w1', { terminalId: 'term-w1' });
    for (const row of [
      { items: [], automation: { ...AUTOMATION, autoSend: false, autoResume: false } },
      { items: [{ id: 1, text: 'x', disabled: true }], automation: null },
      { items: ITEMS, automation: { ...AUTOMATION, paused: true, autoResume: false } },
    ]) {
      const { q, rows, deps } = world([card], { w1: row });
      expect(await stopCentralRun('term-w1', { centralId: 'c1', reason: 'revoked' }, deps)).toBe(false);
      expect(q.writes).toEqual([]);
      expect(rows).toEqual([]);
    }
  });

  it('a queue it cannot write gets a failed row, and nothing throws', async () => {
    const card = makeSession('w1', { terminalId: 'term-w1' });
    const { rows, deps } = world([card], { w1: { items: ITEMS, automation: AUTOMATION } });
    const broken: CentralRunDeps = {
      ...deps,
      queue: async () => ({
        read: () => ({ items: ITEMS, automation: AUTOMATION }),
        write: () => {
          throw new Error('SQLITE_BUSY /Users/x/db');
        },
      }),
    };

    expect(await stopCentralRun('term-w1', { centralId: 'c1', reason: 'revoked' }, broken)).toBe(false);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'failed' });
    expect(rows[0].summary).not.toContain('SQLITE');
  });
});

describe('hands-off on a central’s own worker (Ruling P4-30)', () => {
  function handsOff(cards: Session[], queues: Record<string, Row>) {
    const workers = createWorkerRegistry({ controller: () => null });
    workers.add({ centralId: 'c1', terminalId: 'term-w1', openedAt: 0, folder: '/a', cli: 'claude' });
    const w = world(cards, queues);
    const setter = createHandsOffSetter(
      (id, on) => {
        const card = cards.find((s) => s.sessionId === id) ?? null;
        return card === null ? null : { ...card, ...(on ? { handsOff: true } : {}) };
      },
      () => undefined,
      releaseOnHandsOff({ ...w.deps, workers }),
    );
    return { ...w, workers, setter };
  }

  it('hands-off on an own worker pauses its queue and releases it', async () => {
    const worker = makeSession('w1', { terminalId: 'term-w1' });
    const { q, rows, workers, setter } = handsOff([worker], { w1: { items: ITEMS, automation: AUTOMATION } });

    setter('w1', true);
    await flush();

    expect(workers.ownerOf(worker)).toBeNull();
    expect(workers.of('c1')).toEqual([]);
    expect(q.writes).toHaveLength(1);
    expect(q.writes[0].automation).toMatchObject({ paused: true, autoResume: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ centralId: 'c1', targetSessionId: 'w1' });
    expect(rows[0].summary).toMatch(/hands-off/);
  });

  it("a person's own session's queue is untouched by hands-off", async () => {
    const mine = makeSession('p1', { terminalId: 'term-p1' });
    const worker = makeSession('w1', { terminalId: 'term-w1' });
    const { q, rows, workers, setter } = handsOff([mine, worker], {
      p1: { items: ITEMS, automation: AUTOMATION },
      w1: { items: ITEMS, automation: AUTOMATION },
    });

    setter('p1', true);
    // Turning it off again stops nothing either.
    setter('w1', false);
    await flush();

    expect(q.writes).toEqual([]);
    expect(rows).toEqual([]);
    expect(workers.ownerOf(worker)).toBe('c1');
  });

  it('the server’s setter reaches the handler deliverWiring installs, and none once it is removed', () => {
    const seen: string[] = [];
    const off = onHandsOffTurnedOn((card) => seen.push(card.sessionId));
    handsOffTurnedOn(makeSession('w1'));
    off();
    handsOffTurnedOn(makeSession('w2'));
    expect(seen).toEqual(['w1']);
  });
});
