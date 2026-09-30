import { create } from 'zustand';
import { db } from '@/lib/db';
import type { DbQueueAutomation } from '@/lib/db';
import { getClientId } from '@/lib/deviceIdentity';
import { DEFAULT_MAX_RETRIES } from '@/lib/resumeWatchdog';

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
   *  saw-work gate, exactly like an automated cycle).
   *
   *  On an item that is ALREADY executing the same flag means "resume": it
   *  releases the chain gate for the step the row is parked on
   *  (`chainGateDecision`'s `manualOverride`) WITHOUT touching
   *  `execState`/`execStepIdx`, so the chain continues from its cursor instead
   *  of re-typing step 1 over a running agent. That is the only user-reachable
   *  escape from a chain whose gate is waiting on a CLI signal that never
   *  came. Same one-shot lifetime — `advanceAfterFire` clears it. */
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
   *  governs WHEN). Scoped to ONE session, same as `autoSend`. Independent of
   *  `autoSend` in both directions — toggling one never changes the other
   *  (see `setAutoEnter`'s comment for why that's deliberate). */
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
  /**
   * Auto-resume watchdog: when the terminal prints a transient-failure banner
   * (API 5xx / rate limit / connection error) and the turn dies, send a
   * continuation prompt instead of leaving the session parked. Defaults to
   * true — the whole point is unattended recovery, and a watchdog that is off
   * by default is off at 3am when the 529 actually lands. Bounded by
   * `resumeMaxRetries` over a 30-minute rolling window; see
   * `src/lib/resumeWatchdog.ts`.
   */
  autoResume: boolean;
  /** Resume prompts allowed per rolling 30-minute window. Defaults to 3. */
  resumeMaxRetries: number;
  /** Prompt sent on resume. Empty string falls back to DEFAULT_RESUME_PROMPT. */
  resumePrompt: string;
  /** Session-level time-of-day pause windows applied to all loops in the session. */
  loopExcludeWindows?: ExcludeWindow[];
}

/**
 * The compose row's in-progress, not-yet-added item for ONE session.
 *
 * Mirrors exactly what the compose form needs to reconstruct a `QueueItem` on
 * ADD (see `handleAdd` in `QueueTab.tsx`) — text, attached images, the
 * once/loop/schedule type pill, and the loop/schedule detail fields.
 */
export interface QueueComposeDraft {
  text: string;
  images: QueueImageAttachment[];
  /** Which type pill (Once/Loop/Schedule) is selected for the NEXT item. */
  type: QueueItemType;
  /** Loop interval magnitude, paired with `intervalUnit`. */
  intervalValue: number;
  intervalUnit: 'sec' | 'min' | 'hour';
  /** Schedule one-shot run-at, as a `<input type="datetime-local">` string. */
  runAt: string;
}

interface QueueState {
  queues: Map<string, QueueItem[]>;
  /** Per-session pause + idle-guard + auto-send/auto-enter. Defaults to
   *  { paused:false, autoSend:true, autoEnter:true, idleGuard:true }. */
  automation: Map<string, QueueAutomationConfig>;
  /** Per-session compose-row draft — the item the user is currently building
   *  but has not yet clicked ADD on. Session-scoped for the same reason
   *  `automation` is: `QueueTab` mounts TWICE simultaneously for the same
   *  session (the always-on strip in DetailPanel + the dedicated Queue tab),
   *  and this Map is what lets both mounts show the SAME in-progress draft
   *  rather than two independent, silently-diverging ones. See
   *  `DEFAULT_COMPOSE_DRAFT` and `setComposeDraft`. In-memory only —
   *  deliberately NOT persisted to IndexedDB, unlike `automation`: this is
   *  about not leaking a draft between sessions while the app is open, not
   *  about surviving a restart. */
  composeDrafts: Map<string, QueueComposeDraft>;

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
  /** Per-session auto-resume watchdog toggle. */
  setAutoResume: (sessionId: string, autoResume: boolean) => void;
  /** Resume attempts allowed per rolling window (clamped to 1..10). */
  setResumeMaxRetries: (sessionId: string, retries: number) => void;
  /** Custom resume prompt; empty string restores the default wording. */
  setResumePrompt: (sessionId: string, prompt: string) => void;
  /** Replace the session-level loop exclude windows (quiet hours). */
  setLoopExcludeWindows: (sessionId: string, windows: ExcludeWindow[]) => void;
  /** Replace the entire automation config for a session. Used by workspace
   *  restore to re-attach the snapshot's paused/quiet-hours/auto-send state
   *  under the freshly-created terminal id. */
  setAutomation: (sessionId: string, config: QueueAutomationConfig) => void;

  /** Get (or initialize) the compose draft for a session. */
  getComposeDraft: (sessionId: string) => QueueComposeDraft;
  /** Apply a partial patch to a session's compose draft — e.g.
   *  `setComposeDraft(id, { text })` on every keystroke, or
   *  `setComposeDraft(id, { text: '', images: [], runAt: '' })` after a
   *  successful ADD (only those fields reset — `type`/`intervalValue`/
   *  `intervalUnit` deliberately persist so a batch of loop items doesn't
   *  need re-picking Loop + the interval on every add). */
  setComposeDraft: (sessionId: string, patch: Partial<QueueComposeDraft>) => void;

  /** Re-key queue items (and automation config) when a session is replaced
   *  (e.g., claude --resume). */
  migrateSession: (oldSessionId: string, newSessionId: string) => void;

  /** Load all queues from IndexedDB. Call once on app mount. */
  loadFromDb: () => Promise<void>;

  /**
   * Pull every session's queue from the SERVER and reconcile with what this
   * device loaded from its own IndexedDB. Call once on mount, after
   * `loadFromDb`. Makes the desktop app and a phone on the LAN show the same
   * queue for a session — before this, each browser's IndexedDB was an
   * entirely private copy that never synced.
   */
  syncFromServer: () => Promise<void>;

  /**
   * Apply a queue pushed by ANOTHER device (the `queue_update` WS message).
   * A no-op for our own echo — see `applyRemoteQueue`'s implementation.
   */
  applyRemoteQueue: (
    sessionId: string,
    items: QueueItem[],
    automation: QueueAutomationConfig | null,
    originClientId: string | null,
  ) => void;
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
  autoResume: true,
  resumeMaxRetries: DEFAULT_MAX_RETRIES,
  resumePrompt: '',
}) as QueueAutomationConfig;

/** Stable reference for "no compose draft yet" — same reasoning as
 *  `DEFAULT_AUTOMATION`: selectors fall back to it so a session with no
 *  draft returns a stable object identity rather than minting a fresh one
 *  every render (which would break Zustand's equality check and re-render
 *  in a loop). Values match what the old per-component `useState` calls
 *  initialized to. */
export const DEFAULT_COMPOSE_DRAFT: QueueComposeDraft = Object.freeze({
  text: '',
  images: [],
  type: 'once',
  intervalValue: 10,
  intervalUnit: 'min',
  runAt: '',
}) as QueueComposeDraft;

/**
 * Maps a persisted `DbQueueAutomation` row to the in-memory config shape.
 *
 * Extracted as a pure function (no Dexie, no store access) specifically so
 * the independence of `autoSend`/`autoEnter` on restore is directly
 * unit-testable — IndexedDB isn't available in this test environment, so
 * `loadFromDb` itself has no practical unit-test path, but the row-mapping
 * logic it delegates to here does.
 *
 * Each 0/1 column is read independently — NOT coupled to the other (Aug
 * 2026; see `setAutoEnter`'s comment for why). An earlier version force-set
 * `autoSend: true` whenever `autoEnter` was true, which silently reverted a
 * user's explicit "Auto-send off" choice on every reload — worse than the
 * no-op it was trying to prevent, since a live toggle at least shows a toast.
 *
 * `=== undefined` (not falsy) is what distinguishes "column absent" from
 * "explicit 0": absence means the row was saved before that field existed as
 * a separate per-session column, so it defaults to the prior default-ON
 * behavior; an explicit `0` is a real, meaningful OFF and must survive a
 * reload unchanged.
 */
export function automationConfigFromRow(row: DbQueueAutomation): QueueAutomationConfig {
  let windows: ExcludeWindow[] | undefined;
  if (row.loopExcludeWindows) {
    try { windows = JSON.parse(row.loopExcludeWindows) as ExcludeWindow[]; }
    catch { /* tolerate malformed JSON — fall back to default */ }
  }
  return {
    paused: row.paused === 1,
    autoSend: row.autoSend === undefined ? true : row.autoSend !== 0,
    autoEnter: row.autoEnter === undefined ? true : row.autoEnter !== 0,
    idleGuard: row.idleGuard !== 0, // default true if missing/null
    // Default true when the column is absent on older rows so an
    // upgrade-then-reload preserves the safe behavior.
    skipWhenPrompting: row.skipWhenPrompting === undefined
      ? true
      : row.skipWhenPrompting !== 0,
    // Absent on rows written before the watchdog existed → the default
    // (ON), matching what a fresh session gets.
    autoResume: row.autoResume === undefined ? true : row.autoResume !== 0,
    resumeMaxRetries: row.resumeMaxRetries === undefined
      ? DEFAULT_MAX_RETRIES
      : Math.min(10, Math.max(1, row.resumeMaxRetries)),
    resumePrompt: row.resumePrompt ?? '',
    loopExcludeWindows: windows && windows.length > 0 ? windows : undefined,
  };
}

/**
 * Session IDs currently being loaded from IndexedDB.
 * When setQueue is called during a load, we skip the persist
 * subscription to avoid a delete+re-insert cycle that generates
 * new auto-increment IDs and causes duplicates on reload.
 */
const _skipPersist = new Set<string>();

/** Shape returned by `GET /api/queues` and carried on `queue_update`. */
interface ServerQueueRecord {
  sessionId: string;
  items: unknown[];
  automation: unknown | null;
  updatedAt: number;
}

/**
 * Sessions whose next change must NOT be pushed to the server, because the
 * change CAME from the server. The mirror image of `_skipPersist`, and needed
 * for the same reason: without it, applying a remote update marks the store
 * dirty, which pushes it straight back, which broadcasts it again.
 */
const _skipServerPush = new Set<string>();

/** Coalesces rapid changes (drag-reorder fires per frame) into one PUT. */
const _pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PUSH_DEBOUNCE_MS = 400;

/**
 * Mirror one session's queue to the server so other devices converge on it.
 *
 * Fire-and-forget by design: the local IndexedDB write is what guarantees the
 * user doesn't lose work, so a failed sync must never surface as an error or
 * block the UI — it just means this device stays authoritative until the next
 * change succeeds.
 */
function pushQueueToServer(
  sessionId: string,
  items: QueueItem[],
  automation: QueueAutomationConfig | null,
): void {
  const existing = _pushTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  _pushTimers.set(sessionId, setTimeout(() => {
    _pushTimers.delete(sessionId);
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, automation, originClientId: getClientId() }),
    }).catch(() => { /* offline — local copy remains the source of truth */ });
  }, PUSH_DEBOUNCE_MS));
}

export const useQueueStore = create<QueueState>((set, get) => ({
  queues: new Map(),
  automation: new Map(),
  composeDrafts: new Map(),

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
      // Deliberately independent (Aug 2026) — Auto-send is the WHEN gate (does
      // the scheduler fire at all); Auto-Enter is only HOW (append a real
      // Enter once something does fire). An earlier version forced Auto-send
      // ON whenever Auto-Enter turned on, to stop "Auto-Enter ON, Auto-send
      // OFF" from reading as a silent no-op. That traded away a real, valid
      // combo: Auto-send OFF + Auto-Enter ON means the user drives WHEN
      // manually (⚡ NOW / forceStart still bypasses the Auto-send gate — see
      // useGlobalQueueScheduler.ts) but still wants a real Enter keystroke,
      // not typed-only, whenever they do fire something. Forcing Auto-send on
      // took that choice away every time, and — worse — the restore path
      // (loadFromDb below) re-imposed it on every reload even after a user
      // explicitly turned Auto-send back off, silently reverting their choice
      // with nothing logged. The `queueAutoSendBanner` in QueueTab already
      // tells the user when Auto-send is off and why Loop/Schedule won't fire,
      // so discoverability doesn't depend on this coupling existing.
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

  setAutoResume: (sessionId, autoResume) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      next.set(sessionId, { ...current, autoResume });
      return { automation: next };
    }),

  setResumeMaxRetries: (sessionId, retries) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      // Clamped, not trusted: 0 would mean "retry forever" to a naive reader,
      // and the watchdog treats it as 1 anyway — make the stored value honest.
      const clamped = Math.min(10, Math.max(1, Math.round(retries) || 1));
      next.set(sessionId, { ...current, resumeMaxRetries: clamped });
      return { automation: next };
    }),

  setResumePrompt: (sessionId, prompt) =>
    set((state) => {
      const next = new Map(state.automation);
      const current = next.get(sessionId) ?? DEFAULT_AUTOMATION;
      next.set(sessionId, { ...current, resumePrompt: prompt.slice(0, 4000) });
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

  setAutomation: (sessionId, config) =>
    set((state) => {
      const next = new Map(state.automation);
      next.set(sessionId, { ...config });
      return { automation: next };
    }),

  getComposeDraft: (sessionId) =>
    get().composeDrafts.get(sessionId) ?? DEFAULT_COMPOSE_DRAFT,

  setComposeDraft: (sessionId, patch) =>
    set((state) => {
      const next = new Map(state.composeDrafts);
      const current = next.get(sessionId) ?? DEFAULT_COMPOSE_DRAFT;
      next.set(sessionId, { ...current, ...patch });
      return { composeDrafts: next };
    }),

  migrateSession: (oldSessionId, newSessionId) =>
    set((state) => {
      const items = state.queues.get(oldSessionId);
      const auto = state.automation.get(oldSessionId);
      const draft = state.composeDrafts.get(oldSessionId);
      // Nothing to carry across — leave all three maps untouched.
      if ((!items || items.length === 0) && !auto && !draft) return state;

      const patch: Partial<QueueState> = {};

      if (items && items.length > 0) {
        const nextQueues = new Map(state.queues);
        nextQueues.delete(oldSessionId);
        // Re-key each item's sessionId to the new ID
        nextQueues.set(
          newSessionId,
          items.map((i) => ({ ...i, sessionId: newSessionId })),
        );
        patch.queues = nextQueues;
      }

      // Carry the per-session automation (paused / quiet-hours / auto-send)
      // across the re-key too. Without this, a session the user explicitly
      // paused (or silenced overnight) silently reverts to DEFAULT_AUTOMATION
      // on every `claude --resume` re-key — a paused loop comes back armed.
      if (auto) {
        const nextAutomation = new Map(state.automation);
        nextAutomation.delete(oldSessionId);
        // Don't clobber a config the new id may already have (e.g. set by an
        // explicit restore) — only carry forward when the target is unset.
        if (!nextAutomation.has(newSessionId)) {
          nextAutomation.set(newSessionId, { ...auto });
        }
        patch.automation = nextAutomation;
      }

      // Carry an in-progress compose draft across the re-key too. Without
      // this, a half-typed prompt the user was mid-composing when the
      // session got re-keyed (e.g. `claude --resume` landing while they were
      // typing) would silently vanish — orphaned under an id nothing
      // references any more, since the component's next render reads the
      // NEW id and finds nothing there.
      if (draft) {
        const nextDrafts = new Map(state.composeDrafts);
        nextDrafts.delete(oldSessionId);
        if (!nextDrafts.has(newSessionId)) {
          nextDrafts.set(newSessionId, { ...draft });
        }
        patch.composeDrafts = nextDrafts;
      }

      return patch;
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
          next.set(row.sessionId, automationConfigFromRow(row));
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

  syncFromServer: async () => {
    try {
      const resp = await fetch('/api/queues');
      if (!resp.ok) return;
      const data = await resp.json() as { queues?: ServerQueueRecord[] };
      const records = data.queues ?? [];

      const serverSessions = new Set<string>();
      for (const rec of records) {
        if (!rec?.sessionId || !Array.isArray(rec.items)) continue;
        serverSessions.add(rec.sessionId);
        useQueueStore.getState().applyRemoteQueue(
          rec.sessionId,
          rec.items as QueueItem[],
          (rec.automation ?? null) as QueueAutomationConfig | null,
          // No origin: this is a pull, not an echo of our own push, so it
          // must apply even though we are the one who asked for it.
          null,
        );
      }

      // Seed: a session this device has locally that the SERVER has never
      // heard of. Without this the first device to run the new build would
      // appear to LOSE its queue — the server starts empty, and "server
      // wins" would blank a queue the user can still see in their old app.
      // Only sessions genuinely absent server-side are pushed, so a queue
      // someone already cleared on another device is NOT resurrected from
      // this device's stale IndexedDB copy.
      const state = useQueueStore.getState();
      for (const [sid, items] of state.queues) {
        if (serverSessions.has(sid)) continue;
        if (items.length === 0) continue;
        void pushQueueToServer(sid, items, state.automation.get(sid) ?? null);
      }
    } catch {
      // Offline or server unreachable — the local IndexedDB copy is still
      // fully functional, exactly as before this feature existed.
    }
  },

  applyRemoteQueue: (sessionId, items, automation, originClientId) =>
    set((state) => {
      // Our own echo. Applying it would be harmless data-wise but would mark
      // the store dirty and trigger another push, ping-ponging forever
      // between two devices.
      if (originClientId && originClientId === getClientId()) return state;

      // Suppress the push that this state change would otherwise trigger —
      // we are applying what the server already has, so echoing it back is
      // pure noise (and the other half of the same loop).
      _skipServerPush.add(sessionId);
      setTimeout(() => _skipServerPush.delete(sessionId), 0);

      const patch: Partial<QueueState> = {};
      const nextQueues = new Map(state.queues);
      nextQueues.set(sessionId, [...items].sort((a, b) => a.position - b.position));
      patch.queues = nextQueues;

      if (automation) {
        const nextAutomation = new Map(state.automation);
        nextAutomation.set(sessionId, automation);
        patch.automation = nextAutomation;
      }
      return patch;
    }),
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
    // Mirror to the server so other devices see it. Guarded separately from
    // `_skipPersist`: that one suppresses the IndexedDB write after a local
    // DB load, this one suppresses the push after a REMOTE update — different
    // triggers, and conflating them would either re-echo remote changes or
    // stop local edits from ever syncing.
    if (!_skipServerPush.has(sid)) {
      pushQueueToServer(sid, items, nextAutomation.get(sid) ?? null);
    }
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
          autoResume: cfg.autoResume ? 1 : 0,
          resumeMaxRetries: cfg.resumeMaxRetries,
          // Omit the empty string so a session on the default wording doesn't
          // carry a redundant column.
          resumePrompt: cfg.resumePrompt ? cfg.resumePrompt : undefined,
          loopExcludeWindows:
            cfg.loopExcludeWindows && cfg.loopExcludeWindows.length > 0
              ? JSON.stringify(cfg.loopExcludeWindows)
              : undefined,
          updatedAt: Date.now(),
        })
        .catch(() => { /* silent */ });
    }
    // Automation (paused / auto-send / quiet hours) is part of the shared
    // queue too — a session paused on the desktop must read as paused on the
    // phone, or the two devices disagree about whether the scheduler should
    // fire. Pushed under the same skip-guard as items, and only when the
    // session actually has a queue entry to attach it to.
    if (!_skipServerPush.has(sid) && cfg) {
      pushQueueToServer(sid, nextQueues.get(sid) ?? [], cfg);
    }
  }
});

/**
 * Per-session serialization of queue persists. The persist subscription can
 * fire two updates for the same session in quick succession (e.g.
 * `advanceBlockedLoops` patching multiple due loops in a tight loop). Each
 * persist is a delete-then-add, so two overlapping runs would both read the
 * pre-delete state and re-add the rows, leaving Dexie with duplicate copies
 * that hydrate as doubled queue items on next restart. Chaining per-session
 * guarantees they run strictly one-after-another.
 */
const _persistChains = new Map<string, Promise<void>>();

function persistSessionQueue(sessionId: string, items: QueueItem[]): Promise<void> {
  // Snapshot the items now so a later mutation can't change what this enqueued
  // write persists once it reaches the head of the chain.
  const snapshot = items.map((i) => ({ ...i }));
  const prev = _persistChains.get(sessionId) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* a prior failure must not block later writes */ })
    .then(() => doPersistSessionQueue(sessionId, snapshot));
  _persistChains.set(sessionId, next);
  // Self-clean the map entry once this is the tail (avoid unbounded growth).
  void next.finally(() => {
    if (_persistChains.get(sessionId) === next) _persistChains.delete(sessionId);
  });
  return next;
}

async function doPersistSessionQueue(sessionId: string, items: QueueItem[]): Promise<void> {
  try {
    // Atomic delete+add: an interrupted write (e.g. quit mid-persist) either
    // commits fully or not at all, so the session's queue can never be left
    // deleted-but-not-re-added (whole-queue data loss).
    await db.transaction('rw', db.promptQueue, async () => {
      const existingIds = (
        await db.promptQueue.where('sessionId').equals(sessionId).primaryKeys()
      ).filter((id): id is number => id != null);
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
    });
  } catch {
    // silent
  }
}
