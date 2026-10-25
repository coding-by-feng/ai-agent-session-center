// test/mcp/queueFixtures.ts — what the queue write tests share (queueOps.test.ts, tools.queueWrite*.test.ts): stored
// queue items, a state to run a pure op on, and a QueueStore that keeps its rows in memory and records every call
// (so a test can see what was read, what was written, and under which origin).
import { expect } from 'vitest';
import { ToolError } from '../../server/mcp/types.js';
import type {
  QueueAutomationLike,
  QueueItemLike,
  QueueState,
  QueueStore,
} from '../../server/mcp/queueOps.js';

export const NOW = 1_700_000_000_000;

/** One stored item: the fields the client writes, with the ones a test names changed. */
export function item(id: number, over: Record<string, unknown> = {}): QueueItemLike {
  return { id, sessionId: 's1', text: `item ${id}`, position: 0, createdAt: 1, ...over };
}

/** Items numbered 0..n-1 in the order given, each with the text `item <id>`. */
export const queueOf = (...ids: number[]): QueueItemLike[] => ids.map((id, position) => item(id, { position }));

/** A queue to run an op on. `items` may hold what the server could: entries that are not items at all. */
export const stateOf = (items: readonly unknown[], automation: QueueAutomationLike | null = null): QueueState => ({
  items: items as readonly QueueItemLike[],
  automation,
});

/** The ids of a list of items, in the order they stand. */
export const idsOf = (items: readonly QueueItemLike[]): unknown[] => items.map((i) => (i as { id?: unknown }).id);

/** The stored item with this id (a test fails when there is none). */
export function itemWith(items: readonly QueueItemLike[], id: number): Record<string, unknown> {
  const found = items.find((i) => (i as { id?: unknown }).id === id);
  expect(found, `an item with id ${id}`).toBeDefined();
  return found as Record<string, unknown>;
}

/** A complete automation record, the way the dashboard stores one, with the fields a test names changed. */
export const automationOf = (over: Record<string, unknown> = {}): QueueAutomationLike => ({
  paused: false,
  autoSend: true,
  autoEnter: true,
  idleGuard: true,
  skipWhenPrompting: true,
  autoResume: true,
  resumeMaxRetries: 3,
  resumePrompt: '',
  ...over,
});

export interface StoreWrite {
  sessionId: string;
  items: QueueItemLike[];
  automation: QueueAutomationLike | null;
  originClientId: string;
}

export interface FakeQueueStore extends QueueStore {
  /** The rows, by session id: what a read answers and a write replaces. */
  rows: Map<string, { items: QueueItemLike[]; automation: QueueAutomationLike | null }>;
  /** Every call, in order: `read s1`, `write s1`. */
  calls: string[];
  writes: StoreWrite[];
}

/** A store on a map. A session with no row reads as an empty queue, as the server's does. */
export function fakeQueueStore(
  initial: Record<string, { items: QueueItemLike[]; automation?: QueueAutomationLike | null }> = {},
): FakeQueueStore {
  const rows = new Map(
    Object.entries(initial).map(([id, row]) => [id, { items: [...row.items], automation: row.automation ?? null }]),
  );
  const calls: string[] = [];
  const writes: StoreWrite[] = [];
  return {
    rows,
    calls,
    writes,
    read(sessionId) {
      calls.push(`read ${sessionId}`);
      const row = rows.get(sessionId);
      return { items: row ? [...row.items] : [], automation: row?.automation ?? null };
    },
    write(sessionId, items, automation, originClientId) {
      calls.push(`write ${sessionId}`);
      writes.push({ sessionId, items, automation, originClientId });
      rows.set(sessionId, { items: [...items], automation });
    },
  };
}

/** The refusal an op throws (the test fails when it returns, or throws something else). */
export function refusalOf(call: () => unknown): ToolError {
  try {
    call();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
}
