/**
 * queueHistoryStore — global favorites for queue items.
 *
 * Users click ★ on any queue row to save a snapshot of that item to a global
 * history. Saved entries can later be viewed, edited, or applied (cloned) to
 * any other session — letting them reuse a loop / schedule / chain pattern
 * across projects without rebuilding it by hand.
 *
 * Why this is a separate store (not a slice of queueStore):
 * - Different lifecycle: a history entry survives the deletion of its source
 *   queue item AND its source session.
 * - Different shape: history entries carry breadcrumbs (sourceSessionTitle,
 *   usedCount) that wouldn't make sense on a live queue row.
 * - Different persistence: own Dexie table (queueHistory, v5 schema).
 *
 * Cross-store coupling:
 * - When ★ is toggled ON, we save the entry AND set `historyId` on the live
 *   QueueItem so the star can render filled without a DB round-trip.
 * - When a history entry is deleted, we walk every queue in `queueStore` and
 *   clear `historyId` from any item that pointed at the removed entry.
 *
 * What does NOT live here:
 * - Patterns / multi-item snapshots — out of scope per design discussion.
 * - Edit-then-apply convenience — Apply uses the saved snapshot; users who
 *   want to tweak before applying click Apply, then edit the row in the queue.
 */

import { create } from 'zustand';
import { db } from '@/lib/db';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';

export interface QueueHistoryEntry {
  id: number;
  /** User-chosen alias / display name. null when the user hasn't named it. */
  alias: string | null;
  /** Snapshot of the saved QueueItem. session-local fields are stripped. */
  item: QueueItem;
  sourceSessionTitle: string | null;
  sourceSessionId: string | null;
  usedCount: number;
  createdAt: number;
  lastUsedAt: number | null;
}

interface QueueHistoryState {
  entries: QueueHistoryEntry[];
  loaded: boolean;

  loadFromDb: () => Promise<void>;

  /** Save a queue item as a new history entry. Returns the new entry id so
   *  the caller can stamp `historyId` onto the live queue row. */
  saveItem: (
    item: QueueItem,
    source: { sessionId: string | null; sessionTitle: string | null },
  ) => Promise<number>;

  /** Patch a saved entry's `item` payload (typically from QueueHistorySheet's
   *  Edit action). The breadcrumb / usedCount / timestamps are NOT touched. */
  updateEntry: (id: number, itemPatch: Partial<QueueItem>) => Promise<void>;

  /** Set (or clear) a saved entry's display alias. Pass an empty/blank string
   *  to clear it back to null. Only touches `alias` — never the snapshot. */
  setAlias: (id: number, alias: string) => Promise<void>;

  /** Delete a saved entry AND clear `historyId` from any live queue item
   *  that pointed at it. */
  removeEntry: (id: number) => Promise<void>;

  /** Increment usedCount + bump lastUsedAt for an entry. Called after Apply. */
  incrementUsed: (id: number) => Promise<void>;

  /** Apply an entry to a target session's queue. Clones the snapshot with a
   *  fresh id, resets loop timing / execState, links the new item back to
   *  the history entry via `historyId`, and increments usedCount. */
  applyToSession: (entryId: number, targetSessionId: string) => Promise<void>;

  /** Append a batch of entries from a parsed import file. Each `entry.id` is
   *  ignored; Dexie mints fresh auto-increment ids so the imported entries
   *  don't collide with the user's existing ones. Returns the number of
   *  entries actually written (0 if all writes failed). */
  bulkImport: (entries: Array<Omit<QueueHistoryEntry, 'id'>>) => Promise<number>;
}

/** Strip per-session fields off a QueueItem so the snapshot is portable. */
function snapshotItem(item: QueueItem): QueueItem {
  // A loop must carry a valid interval — a missing/≤0 value would make the
  // applied item deletable on its first fire. Clamp to the 60s default so a
  // corrupt interval never enters the saved pattern.
  const intervalMs =
    item.type === 'loop' &&
    !(Number.isFinite(item.intervalMs) && (item.intervalMs as number) > 0)
      ? 60_000
      : item.intervalMs;
  return {
    // id/sessionId/position are session-local; placeholder values get rewritten
    // when applied to a target session.
    id: 0,
    sessionId: '',
    position: 0,
    createdAt: item.createdAt,
    text: item.text,
    images: item.images,
    type: item.type,
    intervalMs,
    runAt: item.runAt,
    // Reset execution state — a fresh apply starts at the beginning of any chain.
    nextFireAt: undefined,
    lastFiredAt: undefined,
    totalFires: 0,
    execState: undefined,
    execStepIdx: undefined,
    beforeChain: item.beforeChain,
    afterChain: item.afterChain,
    excludeWindows: item.excludeWindows,
    // `disabled` is a per-instance pause state, not a property of the saved
    // pattern. Strip so a freshly applied entry comes in enabled.
    disabled: undefined,
    // `firstFireOfDay` IS part of the pattern (user-configured scheduling).
    // Carry it through unchanged so an applied entry keeps the same daily
    // start clamp.
    firstFireOfDay: item.firstFireOfDay,
  };
}

function rowToEntry(row: {
  id?: number;
  alias?: string;
  item: string;
  sourceSessionTitle?: string;
  sourceSessionId?: string;
  usedCount: number;
  lastUsedAt?: number;
  createdAt: number;
}): QueueHistoryEntry | null {
  if (row.id == null) return null;
  let parsed: QueueItem;
  try {
    parsed = JSON.parse(row.item) as QueueItem;
  } catch {
    return null;
  }
  return {
    id: row.id,
    alias: row.alias ?? null,
    item: parsed,
    sourceSessionTitle: row.sourceSessionTitle ?? null,
    sourceSessionId: row.sourceSessionId ?? null,
    usedCount: row.usedCount ?? 0,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
  };
}

export const useQueueHistoryStore = create<QueueHistoryState>((set, get) => ({
  entries: [],
  loaded: false,

  loadFromDb: async () => {
    try {
      const rows = await db.queueHistory.orderBy('createdAt').reverse().toArray();
      const entries = rows.map(rowToEntry).filter((e): e is QueueHistoryEntry => e !== null);
      set({ entries, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  saveItem: async (item, source) => {
    const snapshot = snapshotItem(item);
    const now = Date.now();
    const newId = await db.queueHistory.add({
      item: JSON.stringify(snapshot),
      sourceSessionTitle: source.sessionTitle ?? undefined,
      sourceSessionId: source.sessionId ?? undefined,
      usedCount: 0,
      createdAt: now,
    });
    const entry: QueueHistoryEntry = {
      id: newId as number,
      alias: null,
      item: snapshot,
      sourceSessionTitle: source.sessionTitle ?? null,
      sourceSessionId: source.sessionId ?? null,
      usedCount: 0,
      lastUsedAt: null,
      createdAt: now,
    };
    set((s) => ({ entries: [entry, ...s.entries] }));
    return entry.id;
  },

  setAlias: async (id, alias) => {
    const trimmed = alias.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    await db.queueHistory.update(id, { alias: next ?? undefined });
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, alias: next } : e)),
    }));
  },

  updateEntry: async (id, itemPatch) => {
    const current = get().entries.find((e) => e.id === id);
    if (!current) return;
    const nextItem: QueueItem = { ...current.item, ...itemPatch };
    // Re-snapshot to strip out anything per-session that may have leaked into
    // the patch.
    const cleaned = snapshotItem(nextItem);
    await db.queueHistory.update(id, { item: JSON.stringify(cleaned) });
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, item: cleaned } : e)),
    }));
  },

  removeEntry: async (id) => {
    await db.queueHistory.delete(id);
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));

    // Clear historyId from any live queue item that pointed at this entry.
    // Without this, the ★ would stay filled but reference a missing record.
    const queueState = useQueueStore.getState();
    for (const [sid, items] of queueState.queues) {
      for (const it of items) {
        if (it.historyId === id) {
          queueState.updateItem(sid, it.id, { historyId: undefined });
        }
      }
    }
  },

  incrementUsed: async (id) => {
    const now = Date.now();
    const current = get().entries.find((e) => e.id === id);
    if (!current) return;
    await db.queueHistory.update(id, {
      usedCount: current.usedCount + 1,
      lastUsedAt: now,
    });
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === id ? { ...e, usedCount: e.usedCount + 1, lastUsedAt: now } : e,
      ),
    }));
  },

  bulkImport: async (entries) => {
    if (entries.length === 0) return 0;
    const rows = entries.map((e) => ({
      alias: e.alias ?? undefined,
      item: JSON.stringify(e.item),
      sourceSessionTitle: e.sourceSessionTitle ?? undefined,
      sourceSessionId: e.sourceSessionId ?? undefined,
      usedCount: e.usedCount ?? 0,
      lastUsedAt: e.lastUsedAt ?? undefined,
      createdAt: e.createdAt,
    }));
    let written = 0;
    try {
      // bulkAdd returns the auto-inc id of the LAST inserted row; we need
      // each row's id to update in-memory state. Use a transaction + sequential
      // add() so we can capture every id without a separate read-back query.
      const newIds: number[] = [];
      await db.transaction('rw', db.queueHistory, async () => {
        for (const row of rows) {
          const id = await db.queueHistory.add(row);
          newIds.push(id as number);
        }
      });
      written = newIds.length;
      const appended: QueueHistoryEntry[] = entries.map((e, i) => ({
        id: newIds[i],
        alias: e.alias ?? null,
        item: e.item,
        sourceSessionTitle: e.sourceSessionTitle ?? null,
        sourceSessionId: e.sourceSessionId ?? null,
        usedCount: e.usedCount ?? 0,
        lastUsedAt: e.lastUsedAt ?? null,
        createdAt: e.createdAt,
      }));
      // Imported entries land at the top of the in-memory list (newest first)
      // so they're immediately visible without scrolling.
      set((s) => ({ entries: [...appended, ...s.entries] }));
    } catch {
      // Whole-transaction failure — nothing was written (Dexie rolled back).
      written = 0;
    }
    return written;
  },

  applyToSession: async (entryId, targetSessionId) => {
    const entry = get().entries.find((e) => e.id === entryId);
    if (!entry) return;

    const queueState = useQueueStore.getState();
    const existing = queueState.queues.get(targetSessionId) ?? [];
    // QueueTab's local id source is `Date.now()` incremented per call. To
    // guarantee no collision with either the existing items in this session
    // (loaded from Dexie auto-inc ids, typically small) or future compose-row
    // adds (which use Date.now()+), take the larger of `Date.now()` and the
    // current max id, then add 1.
    const maxExisting = existing.reduce((m, it) => (it.id > m ? it.id : m), 0);
    const newId = Math.max(maxExisting, Date.now()) + 1;

    const now = Date.now();
    const type = entry.item.type ?? 'once';
    const cloned: QueueItem = {
      ...entry.item,
      id: newId,
      sessionId: targetSessionId,
      position: existing.length,
      createdAt: now,
      historyId: entryId,
      totalFires: 0,
      execState: undefined,
      execStepIdx: undefined,
      // Reset timing: a loop saved at 09:00 shouldn't fire at 09:00 in the
      // new session — recompute from now. Schedule items keep their runAt
      // (the user may want the same wall-clock target).
      nextFireAt:
        type === 'loop'
          ? now + (entry.item.intervalMs ?? 60_000)
          : type === 'schedule'
            ? entry.item.runAt ?? now + 60_000
            : 0,
    };

    queueState.add(targetSessionId, cloned);
    await get().incrementUsed(entryId);
  },
}));
