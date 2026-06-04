import { create } from 'zustand';
import { db } from '@/lib/db';

export interface QueueImageAttachment {
  name: string;
  dataUrl: string;
}

/** Automation type for queue items. */
export type QueueItemType = 'once' | 'loop' | 'schedule';

/**
 * Execution phase for a time-based item's per-firing chain:
 *   'idle'   — not currently executing (or no execState at all)
 *   'before' — running the before-chain at index `execStepIdx`
 *   'main'   — running the item's own prompt
 *   'after'  — running the after-chain at index `execStepIdx`
 */
export type ChainExecState = 'idle' | 'before' | 'main' | 'after';

/** A single step in a before- or after-chain — same shape as a queue item's
 *  text+images, but without scheduling metadata. */
export interface ChainStep {
  id: number;
  text: string;
  images?: QueueImageAttachment[];
}

/**
 * A time-of-day window during which a loop item must NOT fire.
 *
 * Format: 'HH:MM' (24-hour). Both ends accepted in [00:00, 23:59].
 * Semantics:
 *   - start < end           → exclusion is [start, end) within one day
 *   - start > end           → exclusion wraps midnight: [start, 24:00) ∪ [00:00, end)
 *   - start === end         → invalid (no exclusion applied)
 *   - end === '00:00' with start > 0 → naturally wraps; the [00:00, 00:00) half is empty
 *
 * Comparison is done in the user's local timezone — the dashboard runs on the
 * same machine as the AI agent, so local time is what matters.
 */
export interface ExcludeWindow {
  id: number;
  startHHMM: string;
  endHHMM: string;
}

export interface QueueItem {
  id: number;
  sessionId: string;
  text: string;
  position: number;
  createdAt: number;
  images?: QueueImageAttachment[];

  /** Automation type — 'once' (default) consumes the item on fire,
   *  'loop' re-fires every intervalMs, 'schedule' fires once at runAt. */
  type?: QueueItemType;
  /** Loop interval in milliseconds (only when type='loop'). */
  intervalMs?: number;
  /** Schedule one-shot fire time as unix ms (only when type='schedule'). */
  runAt?: number;
  /** Next fire time as unix ms; 0 for 'once' so they win priority sort. */
  nextFireAt?: number;
  /** Last successful send timestamp (unix ms). */
  lastFiredAt?: number;
  /** Total successful fires. */
  totalFires?: number;

  /** Steps that run BEFORE the main prompt, in array order. */
  beforeChain?: ChainStep[];
  /** Steps that run AFTER the main prompt, in array order. */
  afterChain?: ChainStep[];
  /** Time-of-day windows during which a loop item is paused. Only meaningful
   *  for type='loop'. In-flight chains are unaffected — exclusions only block
   *  the START of a new cycle. */
  excludeWindows?: ExcludeWindow[];
  /** Current execution phase. Persisted so a chain resumes mid-step
   *  across browser reloads. */
  execState?: ChainExecState;
  /** Cursor inside `beforeChain`/`afterChain`. Undefined for main/idle. */
  execStepIdx?: number;
  /** When set, this item is favorited and the value is the matching
   *  queueHistory.id. Renders a filled ★. Stays set even if the user later
   *  edits the local row — the saved history entry is a snapshot. Cleared
   *  by the queueHistoryStore when the matching history entry is removed. */
  historyId?: number;
  /** When true, the scheduler completely skips this item — loops don't tick,
   *  schedules don't fire, once items stay queued. The row is dimmed in the
   *  UI but stays in place; the user can re-enable any time without losing
   *  the chain / timing config. Default undefined (=enabled). */
  disabled?: boolean;
  /** Loop-only. Local-time 'HH:MM' (24-hour). When set, the scheduler refuses
   *  to fire the loop before this clock time on any given day — effectively
   *  a morning quiet window from 00:00 to HH:MM. Schedule items have an
   *  explicit `runAt` and ignore this. Once items don't repeat. */
  firstFireOfDay?: string;
  /** Transient, IN-MEMORY ONLY — deliberately absent from the IndexedDB
   *  mapping (a field whitelist), so it never persists and can never fire a
   *  stale chain after a reload. Set by the manual "⚡ NOW" button to make the
   *  global scheduler START this item's FULL before→main→after chain
   *  immediately, bypassing idle-guard, quiet-hours, the daily-start clamp,
   *  skip-prompting, AND the auto-send toggle. Cleared automatically once the
   *  first step fires (the remaining steps proceed via `execState` + the
   *  saw-work gate, exactly like an automated cycle). */
  forceStart?: boolean;
}

/**
 * Per-session automation controls. Persisted to IndexedDB so that a closed
 * AASC reopens with the user's pause / idle-guard / quiet-hours selections
 * intact (previously these were in-memory only and silently reset on reload).
 *
 * `loopExcludeWindows` are session-level "quiet hours" that apply to ALL
 * loop items in the session. Per-item windows on QueueItem.excludeWindows
 * are OR'd with these — the scheduler refuses to start a new loop cycle
 * whenever NOW falls in EITHER list.
 */
export interface QueueAutomationConfig {
  paused: boolean;
  /** Per-session "auto-send a queued prompt when this session is waiting/input"
   *  toggle (the ➤ paper-plane icon). Defaults to true. Scoped to ONE session —
   *  toggling it on session A never affects session B. Both every `QueueTab`
   *  instance for this session AND `useGlobalQueueScheduler` read this one value,
   *  so the visible toggle and the actual firing can never disagree. */
  autoSend: boolean;
  /** Per-session "append a real Enter keystroke (\r) when sending" toggle (the
   *  ↵ icon). Defaults to true. Controls HOW a prompt is delivered (auto-send
   *  governs WHEN). Scoped to ONE session, same as `autoSend`. */
  autoEnter: boolean;
  /** When true, schedule/loop items only fire while session.status ∈ waiting/input/idle. */
  idleGuard: boolean;
  /**
   * When true, the scheduler also skips firing while `session.status === 'prompting'`
   * — the brief window after UserPromptSubmit where the CLI has accepted a
   * prompt but tools haven't started. Defaults to true so a user with
   * idle-guard OFF (loops fire mid-tool) doesn't accidentally clobber the
   * prompt they just submitted. Independent of `idleGuard`.
   */
  skipWhenPrompting: boolean;
  /** Session-level time-of-day pause windows applied to all loops in the session. */
  loopExcludeWindows?: ExcludeWindow[];
}

interface QueueState {
  queues: Map<string, QueueItem[]>;
  /** Per-session pause + idle-guard + auto-send/auto-enter. Defaults to
   *  { paused:false, autoSend:true, autoEnter:true, idleGuard:true }. */
  automation: Map<string, QueueAutomationConfig>;

  add: (sessionId: string, item: QueueItem) => void;
  remove: (sessionId: string, itemId: number) => void;
  reorder: (sessionId: string, orderedIds: number[]) => void;
  moveToSession: (itemIds: number[], fromSessionId: string, toSessionId: string) => void;
  setQueue: (sessionId: string, items: QueueItem[]) => void;
  /** Apply a partial patch to a single queue item. */
  updateItem: (sessionId: string, itemId: number, patch: Partial<QueueItem>) => void;

  /** Get (or initialize) the automation config for a session. */
  getAutomation: (sessionId: string) => QueueAutomationConfig;
  setPaused: (sessionId: string, paused: boolean) => void;
  /** Per-session auto-send toggle (the ➤ icon). */
  setAutoSend: (sessionId: string, autoSend: boolean) => void;
  /** Per-session auto-enter toggle (the ↵ icon). */
  setAutoEnter: (sessionId: string, autoEnter: boolean) => void;
  setIdleGuard: (sessionId: string, idleGuard: boolean) => void;
  setSkipWhenPrompting: (sessionId: string, value: boolean) => void;
  /** Replace the session-level loop exclude windows (quiet hours). */
  setLoopExcludeWindows: (sessionId: string, windows: ExcludeWindow[]) => void;

  /** Re-key queue items when a session is replaced (e.g., claude --resume). */
  migrateSession: (oldSessionId: string, newSessionId: string) => void;

  /** Load all queues from IndexedDB. Call once on app mount. */
  loadFromDb: () => Promise<void>;
}

/** Stable reference for "no automation config set" — exported so component
 *  selectors can fall back to it without minting a fresh object every render
 *  (which would break zustand's strict-equality bail-out and cause an
 *  infinite re-render loop). */
export const DEFAULT_AUTOMATION: QueueAutomationConfig = Object.freeze({
  paused: false,
  autoSend: true,
  autoEnter: true,
  idleGuard: true,
  skipWhenPrompting: true,
}) as QueueAutomationConfig;

/**
 * Session IDs currently being loaded from IndexedDB.
 * When setQueue is called during a load, we skip the persist
 * subscription to avoid a delete+re-insert cycle that generates
 * new auto-increment IDs and causes duplicates on reload.
 */
const _skipPersist = new Set<string>();

export const useQueueStore = create<QueueState>((set, get) => ({
  queues: new Map(),
  automation: new Map(),

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

  updateItem: (sessionId, itemId, patch) =>
    set((state) => {
      const items = state.queues.get(sessionId);
      if (!items) return state;
      let changed = false;
      const updated = items.map((it) => {
        if (it.id !== itemId) return it;
        changed = true;
        return { ...it, ...patch };
      });
      if (!changed) return state;
      const next = new Map(state.queues);
      next.set(sessionId, updated);
      return { queues: next };
    }),

  getAutomation: (sessionId) =>
    get().automation.get(sessionId) ?? DEFAULT_AUTOMATION,

  setPaused: (sessionId, paused) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      next.set(sessionId, { ...current, paused });
      return { automation: next };
    }),

  setAutoSend: (sessionId, autoSend) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      next.set(sessionId, { ...current, autoSend });
      return { automation: next };
    }),

  setAutoEnter: (sessionId, autoEnter) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      next.set(sessionId, { ...current, autoEnter });
      return { automation: next };
    }),

  setIdleGuard: (sessionId, idleGuard) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      next.set(sessionId, { ...current, idleGuard });
      return { automation: next };
    }),

  setSkipWhenPrompting: (sessionId, value) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      next.set(sessionId, { ...current, skipWhenPrompting: value });
      return { automation: next };
    }),

  setLoopExcludeWindows: (sessionId, windows) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      next.set(sessionId, {
        ...current,
        // Strip empty array to keep the persisted shape minimal.
        loopExcludeWindows: windows.length > 0 ? windows : undefined,
      });
      return { automation: next };
    }),

  migrateSession: (oldSessionId, newSessionId) =>
    set((state) => {
      const items = state.queues.get(oldSessionId);
      if (!items || items.length === 0) return state;
      const next = new Map(state.queues);
      next.delete(oldSessionId);
      // Re-key each item's sessionId to the new ID
      next.set(
        newSessionId,
        items.map((i) => ({ ...i, sessionId: newSessionId })),
      );
      return { queues: next };
    }),

  loadFromDb: async () => {
    // ---- Hydrate automation rows first --------------------------------
    // Done before queue items so the scheduler reads the freshest config
    // on first tick after mount. A row may be absent — that just means
    // the session uses defaults.
    try {
      const autoRows = await db.queueAutomation.toArray();
      if (autoRows.length > 0) {
        const next = new Map<string, QueueAutomationConfig>();
        for (const row of autoRows) {
          let windows: ExcludeWindow[] | undefined;
          if (row.loopExcludeWindows) {
            try { windows = JSON.parse(row.loopExcludeWindows) as ExcludeWindow[]; }
            catch { /* tolerate malformed JSON — fall back to default */ }
          }
          next.set(row.sessionId, {
            paused: row.paused === 1,
            // Default true when the column is absent on older rows (rows saved
            // before auto-send/auto-enter became per-session) so the prior
            // default-ON behavior is preserved after the upgrade.
            autoSend: row.autoSend === undefined ? true : row.autoSend !== 0,
            autoEnter: row.autoEnter === undefined ? true : row.autoEnter !== 0,
            idleGuard: row.idleGuard !== 0, // default true if missing/null
            // Default true when the column is absent on older rows so an
            // upgrade-then-reload preserves the safe behavior.
            skipWhenPrompting: row.skipWhenPrompting === undefined
              ? true
              : row.skipWhenPrompting !== 0,
            loopExcludeWindows: windows && windows.length > 0 ? windows : undefined,
          });
        }
        // Mark these sessionIds so the persist subscription doesn't echo
        // the load straight back into Dexie.
        for (const sid of next.keys()) _skipAutomationPersist.add(sid);
        useQueueStore.setState({ automation: next });
        setTimeout(() => _skipAutomationPersist.clear(), 0);
      }
    } catch {
      // silent — automation defaults to in-memory map
    }

    try {
      const allItems = await db.promptQueue.toArray();
      if (allItems.length === 0) return;

      const bySession = new Map<string, QueueItem[]>();
      for (const d of allItems) {
        const items = bySession.get(d.sessionId) ?? [];
        let images: QueueImageAttachment[] | undefined;
        if (d.images) {
          try { images = JSON.parse(d.images); } catch { /* ignore */ }
        }
        let beforeChain: ChainStep[] | undefined;
        let afterChain: ChainStep[] | undefined;
        let excludeWindows: ExcludeWindow[] | undefined;
        if (d.beforeChain) {
          try { beforeChain = JSON.parse(d.beforeChain) as ChainStep[]; } catch { /* ignore */ }
        }
        if (d.afterChain) {
          try { afterChain = JSON.parse(d.afterChain) as ChainStep[]; } catch { /* ignore */ }
        }
        if (d.excludeWindows) {
          try { excludeWindows = JSON.parse(d.excludeWindows) as ExcludeWindow[]; } catch { /* ignore */ }
        }
        const execStateRaw = d.execState as ChainExecState | undefined;
        const execState =
          execStateRaw === 'before' ||
          execStateRaw === 'main' ||
          execStateRaw === 'after' ||
          execStateRaw === 'idle'
            ? execStateRaw
            : undefined;
        items.push({
          id: d.id!,
          sessionId: d.sessionId,
          text: d.text,
          position: d.position,
          createdAt: d.createdAt,
          images,
          type: d.type,
          intervalMs: d.intervalMs,
          runAt: d.runAt,
          nextFireAt: d.nextFireAt,
          lastFiredAt: d.lastFiredAt,
          totalFires: d.totalFires,
          beforeChain,
          afterChain,
          excludeWindows,
          execState,
          execStepIdx: d.execStepIdx,
          historyId: d.historyId,
          disabled: d.disabled ? true : undefined,
          firstFireOfDay: d.firstFireOfDay,
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
/** Same idea for the automation map — persist only sessions whose entry
 *  changed. Skip set prevents the load-then-resave echo. */
let _prevAutomation: Map<string, QueueAutomationConfig> = new Map();
const _skipAutomationPersist = new Set<string>();

useQueueStore.subscribe((state) => {
  const nextQueues = state.queues;
  const nextAutomation = state.automation;

  // -- queue items --
  const changedSessionIds: string[] = [];
  for (const [sid, items] of nextQueues) {
    if (_prevQueues.get(sid) !== items) changedSessionIds.push(sid);
  }
  for (const sid of _prevQueues.keys()) {
    if (!nextQueues.has(sid)) changedSessionIds.push(sid);
  }
  _prevQueues = nextQueues;
  for (const sid of changedSessionIds) {
    if (_skipPersist.has(sid)) continue;
    const items = nextQueues.get(sid) ?? [];
    persistSessionQueue(sid, items);
  }

  // -- automation config (paused / idleGuard / loopExcludeWindows) --
  // We persist on every entry change so the user's quiet hours and pause
  // toggles roundtrip across AASC restarts.
  const automationChanged: string[] = [];
  for (const [sid, cfg] of nextAutomation) {
    if (_prevAutomation.get(sid) !== cfg) automationChanged.push(sid);
  }
  for (const sid of _prevAutomation.keys()) {
    if (!nextAutomation.has(sid)) automationChanged.push(sid);
  }
  _prevAutomation = nextAutomation;
  for (const sid of automationChanged) {
    if (_skipAutomationPersist.has(sid)) continue;
    const cfg = nextAutomation.get(sid);
    if (!cfg) {
      // Entry removed → drop the row.
      void db.queueAutomation.delete(sid).catch(() => { /* silent */ });
    } else {
      void db.queueAutomation
        .put({
          sessionId: sid,
          paused: cfg.paused ? 1 : 0,
          autoSend: cfg.autoSend ? 1 : 0,
          autoEnter: cfg.autoEnter ? 1 : 0,
          idleGuard: cfg.idleGuard ? 1 : 0,
          skipWhenPrompting: cfg.skipWhenPrompting ? 1 : 0,
          loopExcludeWindows:
            cfg.loopExcludeWindows && cfg.loopExcludeWindows.length > 0
              ? JSON.stringify(cfg.loopExcludeWindows)
              : undefined,
          updatedAt: Date.now(),
        })
        .catch(() => { /* silent */ });
    }
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
          images: item.images ? JSON.stringify(item.images) : undefined,
          type: item.type,
          intervalMs: item.intervalMs,
          runAt: item.runAt,
          nextFireAt: item.nextFireAt,
          lastFiredAt: item.lastFiredAt,
          totalFires: item.totalFires,
          beforeChain: item.beforeChain && item.beforeChain.length > 0 ? JSON.stringify(item.beforeChain) : undefined,
          afterChain: item.afterChain && item.afterChain.length > 0 ? JSON.stringify(item.afterChain) : undefined,
          excludeWindows: item.excludeWindows && item.excludeWindows.length > 0 ? JSON.stringify(item.excludeWindows) : undefined,
          execState: item.execState,
          execStepIdx: item.execStepIdx,
          historyId: item.historyId,
          disabled: item.disabled ? 1 : undefined,
          firstFireOfDay: item.firstFireOfDay,
        })),
      );
    }
  } catch {
    // silent
  }
}
