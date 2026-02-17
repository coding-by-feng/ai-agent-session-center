import { create } from 'zustand';

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
}

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
}));
