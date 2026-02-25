import { create } from 'zustand';
import { db } from '@/lib/db';

export interface QueueItem {
  id: number;
  sessionId: string;
  text: string;
  position: number;
  createdAt: number;
}

interface QueueState {
  queues: Map<string, QueueItem[]>;

  add: (sessionId: string, item: QueueItem) => void;
  remove: (sessionId: string, itemId: number) => void;
  reorder: (sessionId: string, orderedIds: number[]) => void;
  moveToSession: (itemIds: number[], fromSessionId: string, toSessionId: string) => void;
  setQueue: (sessionId: string, items: QueueItem[]) => void;

  /** Load all queues from IndexedDB. Call once on app mount. */
  loadFromDb: () => Promise<void>;
}

/**
 * Session IDs currently being loaded from IndexedDB.
 * When setQueue is called during a load, we skip the persist
 * subscription to avoid a delete+re-insert cycle that generates
 * new auto-increment IDs and causes duplicates on reload.
 */
const _skipPersist = new Set<string>();

export const useQueueStore = create<QueueState>((set) => ({
  queues: new Map(),

  add: (sessionId, item) =>
    set((state) => {
      const next = new Map(state.queues);
      const items = [...(next.get(sessionId) ?? []), item];
      next.set(sessionId, items);
      return { queues: next };
    }),

  remove: (sessionId, itemId) =>
    set((state) => {
      const next = new Map(state.queues);
      const items = (next.get(sessionId) ?? []).filter((i) => i.id !== itemId);
      next.set(sessionId, items);
      return { queues: next };
    }),

  reorder: (sessionId, orderedIds) =>
    set((state) => {
      const next = new Map(state.queues);
      const items = next.get(sessionId) ?? [];
      const byId = new Map(items.map((i) => [i.id, i]));
      const reordered = orderedIds
        .map((id, idx) => {
          const item = byId.get(id);
          return item ? { ...item, position: idx } : null;
        })
        .filter((i): i is QueueItem => i !== null);
      next.set(sessionId, reordered);
      return { queues: next };
    }),

  moveToSession: (itemIds, fromSessionId, toSessionId) =>
    set((state) => {
      const next = new Map(state.queues);
      const fromItems = next.get(fromSessionId) ?? [];
      const toItems = [...(next.get(toSessionId) ?? [])];
      const idsToMove = new Set(itemIds);

      const moving: QueueItem[] = [];
      const remaining: QueueItem[] = [];
      for (const item of fromItems) {
        if (idsToMove.has(item.id)) {
          moving.push(item);
        } else {
          remaining.push(item);
        }
      }

      let maxPos = toItems.length > 0 ? Math.max(...toItems.map((i) => i.position)) : -1;
      for (const item of moving) {
        maxPos++;
        toItems.push({ ...item, sessionId: toSessionId, position: maxPos });
      }

      next.set(fromSessionId, remaining);
      next.set(toSessionId, toItems);
      return { queues: next };
    }),

  setQueue: (sessionId, items) =>
    set((state) => {
      const next = new Map(state.queues);
      next.set(sessionId, items);
      return { queues: next };
    }),

  loadFromDb: async () => {
    try {
      const allItems = await db.promptQueue.toArray();
      if (allItems.length === 0) return;

      const bySession = new Map<string, QueueItem[]>();
      for (const d of allItems) {
        const items = bySession.get(d.sessionId) ?? [];
        items.push({
          id: d.id!,
          sessionId: d.sessionId,
          text: d.text,
          position: d.position,
          createdAt: d.createdAt,
        });
        bySession.set(d.sessionId, items);
      }

      // Mark all loaded sessions to skip persist
      for (const sid of bySession.keys()) {
        _skipPersist.add(sid);
      }

      for (const [sid, items] of bySession) {
        items.sort((a, b) => a.position - b.position);
        useQueueStore.getState().setQueue(sid, items);
      }

      // Clear skip flags after a tick (persist subscription runs synchronously)
      setTimeout(() => _skipPersist.clear(), 0);
    } catch {
      // silent
    }
  },
}));

// ---------------------------------------------------------------------------
// Persist subscription: write queue changes to IndexedDB
// ---------------------------------------------------------------------------

/** Track the previous queues map to detect which sessions changed. */
let _prevQueues: Map<string, QueueItem[]> = new Map();

useQueueStore.subscribe((state) => {
  const nextQueues = state.queues;

  // Find which session IDs changed
  const changedSessionIds: string[] = [];
  for (const [sid, items] of nextQueues) {
    if (_prevQueues.get(sid) !== items) {
      changedSessionIds.push(sid);
    }
  }
  // Also check for removed sessions
  for (const sid of _prevQueues.keys()) {
    if (!nextQueues.has(sid)) {
      changedSessionIds.push(sid);
    }
  }

  _prevQueues = nextQueues;

  // Persist only changed sessions, skipping those just loaded from DB
  for (const sid of changedSessionIds) {
    if (_skipPersist.has(sid)) continue;

    const items = nextQueues.get(sid) ?? [];
    persistSessionQueue(sid, items);
  }
});

async function persistSessionQueue(sessionId: string, items: QueueItem[]): Promise<void> {
  try {
    const existing = await db.promptQueue
      .where('sessionId')
      .equals(sessionId)
      .toArray();
    const existingIds = existing
      .map((e) => e.id)
      .filter((id): id is number => id != null);
    if (existingIds.length > 0) {
      await db.promptQueue.bulkDelete(existingIds);
    }
    if (items.length > 0) {
      await db.promptQueue.bulkAdd(
        items.map((item, idx) => ({
          sessionId,
          text: item.text,
          position: idx,
          createdAt: item.createdAt,
        })),
      );
    }
  } catch {
    // silent
  }
}
