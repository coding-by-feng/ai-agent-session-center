/**
 * QueueTab - Per-session prompt queue management.
 * Features: compose + add, reorder (drag), edit, delete, send now,
 * move to another session, auto-send on "waiting" status.
 * Uses Terminal.module.css queue styles.
 *
 * EDIT opens `QueueItemEditModal` for EVERY item type — the same editor the
 * history sheet's Edit button opens. There is deliberately no lightweight
 * in-row textarea any more: squeezed between the position number and the action
 * group it rendered as a sliver, and its autocomplete dropdown was clipped by
 * `.queueBody`'s 250px scroll box. One editor, one behaviour, everywhere.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueueStore, DEFAULT_AUTOMATION, type QueueItem, type QueueImageAttachment, type QueueItemType } from '@/stores/queueStore';
import {
  applyTypeDefaults,
  itemType,
  describeNextFire,
  formatInterval,
  hasChain,
  isBeforeDailyStart,
  isExecuting,
  isItemInQuietHours,
  isSendableStatus,
  totalChainSteps,
  currentChainStep,
} from '@/lib/queueScheduler';
import { parseHHMM } from '@/lib/timePicker';
import { sendPromptToTerminal } from '@/lib/terminalSend';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueHistoryStore } from '@/stores/queueHistoryStore';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';
import { showToast } from '@/components/ui/ToastContainer';
import AutocompleteTextarea from '@/components/ui/AutocompleteTextarea';
import PromptSnippetPicker, {
  BookmarkIcon,
  BookmarkStackIcon,
  SNIPPET_TRIGGER_ATTR,
} from './PromptSnippetPicker';
import { appendSnippet } from '@/lib/promptSnippetInsert';
import QueueItemEditModal from './QueueItemEditModal';
import QueueMovePicker, {
  MOVE_TRIGGER_ATTR,
  type QueueMoveTarget,
} from './QueueMovePicker';
import QueueHistorySheet from './QueueHistorySheet';
import LoopExcludeWindowsModal from './LoopExcludeWindowsModal';
import styles from '@/styles/modules/Terminal.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextLocalId = Date.now();
function localId(): number {
  return nextLocalId++;
}

/** Format an HH:MM 24-hour string as a 12-hour display string ("9:00 AM"). */
function formatClampDisplay(hhmm: string | undefined): string {
  const parts = parseHHMM(hhmm);
  if (!parts) return hhmm ?? '';
  return `${parts.hour}:${String(parts.minute).padStart(2, '0')} ${parts.ampm}`;
}

/** Stable empty array — prevents useSyncExternalStore infinite loop from `?? []` */
const EMPTY_QUEUE: QueueItem[] = [];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface QueueTabProps {
  sessionId: string;
  sessionStatus: string;
  terminalId?: string | null;
  /** Send a WS message to update queue count on the server */
  onQueueCountChange?: (sessionId: string, count: number) => void;
}

export default function QueueTab({
  sessionId,
  sessionStatus,
  terminalId,
  onQueueCountChange,
}: QueueTabProps) {
  const items = useQueueStore((s) => s.queues.get(sessionId) ?? EMPTY_QUEUE);
  const add = useQueueStore((s) => s.add);
  const remove = useQueueStore((s) => s.remove);
  const reorder = useQueueStore((s) => s.reorder);
  const moveToSession = useQueueStore((s) => s.moveToSession);
  const updateItem = useQueueStore((s) => s.updateItem);
  /** Automation config for this session. Falls back to a frozen sentinel so
   *  the selector returns a stable reference and doesn't trigger a
   *  re-render loop when no entry exists yet (default state for most
   *  sessions). */
  const automationConfig = useQueueStore(
    (s) => s.automation.get(sessionId) ?? DEFAULT_AUTOMATION,
  );
  const setPaused = useQueueStore((s) => s.setPaused);
  const setIdleGuard = useQueueStore((s) => s.setIdleGuard);
  const setSkipWhenPrompting = useQueueStore((s) => s.setSkipWhenPrompting);
  const setLoopExcludeWindows = useQueueStore((s) => s.setLoopExcludeWindows);
  /** Open state for the session-level quiet-hours sheet. */
  const [quietHoursOpen, setQuietHoursOpen] = useState(false);
  /** Open state for the global queue-history sheet. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const sessions = useSessionStore((s) => s.sessions);
  const currentSession = sessions.get(sessionId);
  const currentSessionTitle = currentSession?.title ?? '';
  const currentProjectPath = currentSession?.projectPath ?? null;

  const historyEntries = useQueueHistoryStore((s) => s.entries);
  const historyCount = historyEntries.length;
  const saveToHistory = useQueueHistoryStore((s) => s.saveItem);
  const removeFromHistory = useQueueHistoryStore((s) => s.removeEntry);

  const handleToggleEnabled = useCallback(
    (item: QueueItem) => {
      const nowDisabled = !item.disabled;
      const patch: Partial<QueueItem> = {
        disabled: nowDisabled ? true : undefined,
      };
      // Re-enabling a loop: reset nextFireAt so it waits a full interval
      // before firing (otherwise a frozen-in-the-past nextFireAt would
      // immediately trigger on the next scheduler tick).
      if (!nowDisabled && itemType(item) === 'loop' && item.intervalMs) {
        patch.nextFireAt = Date.now() + item.intervalMs;
      }
      updateItem(sessionId, item.id, patch);
      showToast(nowDisabled ? 'Item paused' : 'Item enabled', 'info', 1200);
    },
    [updateItem, sessionId],
  );

  const handleToggleFavorite = useCallback(
    async (item: QueueItem) => {
      if (item.historyId != null) {
        // Unfavorite — silent toggle, clear the marker on the live item too.
        await removeFromHistory(item.historyId);
        updateItem(sessionId, item.id, { historyId: undefined });
        showToast('Removed from history', 'info', 1200);
      } else {
        const newId = await saveToHistory(item, {
          sessionId,
          sessionTitle: currentSessionTitle,
        });
        updateItem(sessionId, item.id, { historyId: newId });
        showToast('Saved to history', 'info', 1200);
      }
    },
    [removeFromHistory, saveToHistory, updateItem, sessionId, currentSessionTitle],
  );

  const [composeText, setComposeText] = useState('');
  const [composeImages, setComposeImages] = useState<QueueImageAttachment[]>([]);
  /** Automation type for the next item added via the compose row. */
  const [composeType, setComposeType] = useState<QueueItemType>('once');
  /** Loop interval as a "value + unit" tuple (60 minutes by default). */
  const [composeIntervalValue, setComposeIntervalValue] = useState<number>(10);
  const [composeIntervalUnit, setComposeIntervalUnit] = useState<'sec' | 'min' | 'hour'>('min');
  /** Schedule one-shot run-at as a datetime-local string. */
  const [composeRunAt, setComposeRunAt] = useState<string>('');
  const imageInputRef = useRef<HTMLInputElement>(null);
  /** Item id open in the edit modal. EDIT on any row (once / loop / schedule)
   *  sets this — there is no separate inline-edit mode. */
  const [chainEditId, setChainEditId] = useState<number | null>(null);
  /** The compose row's "saved prompts" trigger, while its picker is open. */
  const [snippetAnchor, setSnippetAnchor] = useState<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem('queue-panel-collapsed');
      return stored === null ? true : stored === '1';
    } catch { return true; }
  });
  // Per-session auto-send / auto-enter. These live in THIS session's
  // QueueAutomationConfig (read above as `automationConfig`), so toggling them
  // affects only the current session. Both QueueTab mounts for a session AND
  // `useGlobalQueueScheduler` read the same store value, so the visible toggle
  // and the actual firing stay in lockstep.
  const autoSend = automationConfig.autoSend;
  const autoEnter = automationConfig.autoEnter;
  const setAutoSend = useQueueStore((s) => s.setAutoSend);
  const setAutoEnter = useQueueStore((s) => s.setAutoEnter);
  const [movingItemId, setMovingItemId] = useState<number | null>(null);
  /** The MOVE button the picker hangs off. The picker portals out to <body>, so
   *  it can no longer derive placement from its parent row — it needs the
   *  trigger element itself to measure against. */
  const [moveAnchor, setMoveAnchor] = useState<HTMLElement | null>(null);
  /** Id (not index) of the row being dragged — index is derived live so a
   *  concurrent scheduler add/remove can't shift it out from under the drag. */
  const [draggingId, setDraggingId] = useState<number | null>(null);

  // ---- Snap composeType back to Once when Auto-send turns OFF ----
  // Loop/Schedule items can't fire without Auto-send. If the user toggles
  // Auto-send off while Loop or Schedule is selected, drop back to Once so
  // ADD doesn't quietly create dead items.
  useEffect(() => {
    if (!autoSend && composeType !== 'once') {
      setComposeType('once');
    }
  }, [autoSend, composeType]);

  // ---- Live countdown tick ----
  // `describeNextFire` reads Date.now() on render, so the countdown freezes
  // unless we re-render every second. Only LOOP items need this — schedule
  // items render their configured datetime statically, and Once items have
  // no time display at all. Limiting the ticker to loops keeps Once-only and
  // Schedule-only queues fully tick-free.
  const hasLoopItem = items.some((it) => itemType(it) === 'loop');
  const [, setTickNow] = useState(0);
  useEffect(() => {
    if (!hasLoopItem) return;
    const id = setInterval(() => setTickNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasLoopItem]);

  // #13: Reset transient row state when the session changes — an open modal or
  // picker belongs to the session it was opened from.
  useEffect(() => {
    setChainEditId(null);
    setMovingItemId(null);
    setSnippetAnchor(null);
  }, [sessionId]);

  // Notify parent of queue count changes
  useEffect(() => {
    onQueueCountChange?.(sessionId, items.length);
  }, [items.length, sessionId, onQueueCountChange]);

  // ---- Upload images to server and get back file paths ----
  const uploadImages = useCallback(async (images: QueueImageAttachment[]): Promise<string[]> => {
    try {
      const res = await fetch('/api/queue-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.paths ?? [];
      }
    } catch { /* ignore */ }
    return [];
  }, []);

  // ---- Send a queue item to terminal (text + optional images) ----
  const sendItemToTerminal = useCallback(
    async (item: QueueItem): Promise<boolean> => {
      if (!terminalId) {
        showToast('No terminal attached', 'error');
        return false;
      }
      let textToSend = item.text.replace(/\\n/g, '\n');
      if (item.images && item.images.length > 0) {
        const paths = await uploadImages(item.images);
        if (paths.length > 0) textToSend += '\n' + paths.join('\n');
      }
      // Auto-Enter submits with a SEPARATE Enter keystroke. Concatenating "\r"
      // onto the text makes Claude Code / Codex / Gemini TUIs insert a newline in
      // the input box instead of submitting; a standalone "\r" sent after the text
      // registers as a real Enter keypress. See sendPromptToTerminal.
      const ok = await sendPromptToTerminal(terminalId, textToSend, autoEnter);
      if (!ok) {
        showToast('Failed to send to terminal', 'error');
        return false;
      }
      return true;
    },
    [terminalId, uploadImages, autoEnter],
  );


  // The actual 1s scheduler tick lives in `useGlobalQueueScheduler`
  // (mounted in App.tsx Dashboard) so it keeps evaluating background
  // sessions even when their QueueTab is unmounted. This tab only handles
  // UI, compose, and manual "send now".

  // Autocomplete (slash commands / @ files) is owned by <AutocompleteTextarea>;
  // both the compose row and every prompt textarea inside QueueItemEditModal
  // use the same component, so nothing autocomplete-related lives here anymore.

  // ---- Image file picker ----
  const handleImagePick = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const handleImageFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const readers = files.slice(0, 5).map(
      (f) =>
        new Promise<QueueImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({ name: f.name, dataUrl: reader.result as string });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        }),
    );
    Promise.allSettled(readers).then((results) => {
      const imgs = results
        .filter((r): r is PromiseFulfilledResult<QueueImageAttachment> => r.status === 'fulfilled')
        .map((r) => r.value);
      setComposeImages((prev) => [...prev, ...imgs].slice(0, 5));
    });
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, []);

  const handleRemoveComposeImage = useCallback((idx: number) => {
    setComposeImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // ---- Paste images/files from clipboard ----
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    // Prevent pasting binary as text
    e.preventDefault();
    const readers = files.slice(0, 5).map(
      (f) =>
        new Promise<QueueImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({ name: f.name, dataUrl: reader.result as string });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        }),
    );
    Promise.allSettled(readers).then((results) => {
      const imgs = results
        .filter((r): r is PromiseFulfilledResult<QueueImageAttachment> => r.status === 'fulfilled')
        .map((r) => r.value);
      setComposeImages((prev) => [...prev, ...imgs].slice(0, 5));
    });
  }, []);

  // ---- Drag and drop files onto compose area ----
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const readers = files.slice(0, 5).map(
      (f) =>
        new Promise<QueueImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({ name: f.name, dataUrl: reader.result as string });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        }),
    );
    Promise.allSettled(readers).then((results) => {
      const imgs = results
        .filter((r): r is PromiseFulfilledResult<QueueImageAttachment> => r.status === 'fulfilled')
        .map((r) => r.value);
      setComposeImages((prev) => [...prev, ...imgs].slice(0, 5));
    });
  }, []);

  // ---- Add to queue ----
  const handleAdd = useCallback(() => {
    const trimmed = composeText.trim();
    if (!trimmed && composeImages.length === 0) return;
    const base = {
      id: localId(),
      sessionId,
      text: trimmed,
      position: items.length,
      createdAt: Date.now(),
      images: composeImages.length > 0 ? [...composeImages] : undefined,
    };
    // Translate the compose form into the runtime options expected by the
    // scheduler. `loop` always gets an interval in ms; `schedule` carries an
    // absolute unix-ms timestamp (computed from the datetime-local input).
    const unitMs =
      composeIntervalUnit === 'sec' ? 1000
        : composeIntervalUnit === 'min' ? 60_000
          : 3_600_000;
    const intervalMs = Math.max(1, composeIntervalValue) * unitMs;
    let runAt: number | undefined;
    if (composeType === 'schedule' && composeRunAt) {
      const parsed = Date.parse(composeRunAt);
      if (!Number.isNaN(parsed)) runAt = parsed;
    }
    const newItem = applyTypeDefaults(base, composeType, { intervalMs, runAt });
    add(sessionId, newItem);
    setComposeText('');
    setComposeImages([]);
    // Reset the schedule time so the next 'schedule' item asks for a new one,
    // but keep the type + interval since power-users often add a batch.
    setComposeRunAt('');
  }, [
    composeText,
    composeImages,
    composeType,
    composeIntervalValue,
    composeIntervalUnit,
    composeRunAt,
    sessionId,
    items.length,
    add,
  ]);

  // ---- Saved-prompt snippets (compose row) ----
  const saveSnippet = usePromptSnippetStore((s) => s.save);
  const composeSnippetSaved = usePromptSnippetStore((s) => s.hasText(composeText));

  const handleKeepComposeText = useCallback(async () => {
    const result = await saveSnippet(composeText);
    if (result.id == null) {
      showToast(
        composeText.trim() ? 'Could not save that prompt' : 'Nothing to save yet',
        composeText.trim() ? 'error' : 'info',
        2000,
      );
    } else if (result.duplicate) {
      showToast('Already in saved prompts', 'info', 1500);
    } else {
      showToast('Saved for reuse', 'info', 1500);
    }
  }, [saveSnippet, composeText]);

  // ---- Send now (first item or specific item) — only remove after successful send ----
  // Used for 'once' items: send the text and consume the queue entry. For loop
  // and schedule items, prefer `handleTriggerNow` which preserves loop config
  // and advances nextFireAt properly.
  const handleSendNow = useCallback(
    async (item: QueueItem) => {
      const sent = await sendItemToTerminal(item);
      if (sent) {
        remove(sessionId, item.id);
      }
    },
    [sendItemToTerminal, remove, sessionId],
  );

  // ---- Trigger now for loop / schedule items ----
  // Hands the item's FULL before→main→after chain to the global scheduler
  // (useGlobalQueueScheduler), which drives it step-by-step with the saw-work
  // gate — each step waits for the previous step's turn to actually finish
  // before the next is sent, so prompts never pile up in the CLI input box.
  // `forceStart` makes the scheduler begin immediately, bypassing idle-guard /
  // quiet-hours / daily-start / skip-prompting AND the auto-send toggle (a
  // manual trigger is a deliberate user action). On completion the scheduler
  // reschedules a loop (next cycle = now + interval) or removes a schedule.
  // The first step fires on the next scheduler tick (≤1s) rather than perfectly
  // synchronously — the deliberate trade for keeping the gate machinery a
  // single source of truth instead of duplicating it here. Items with no chain
  // behave exactly as before (just the main prompt, then reschedule/remove).
  const handleTriggerNow = useCallback(
    async (item: QueueItem) => {
      const t = itemType(item);
      if (t === 'once' && !hasChain(item)) {
        // A plain 'once' item is a single prompt — keep the direct
        // send-and-remove path. A CHAINED 'once' falls through to the
        // forceStart path below so its before→main→after steps are driven by
        // the scheduler (and paced by the saw-work gate) instead of being
        // flattened to a single send that would silently drop the chain.
        await handleSendNow(item);
        return;
      }
      // ⚡ NOW only ever STARTS a fresh chain. If this item's chain is already
      // mid-flight, do nothing: resetting its execState would delete the
      // saw-work gate and type step 1 on top of the still-working agent,
      // breaking chain atomicity. (The button is also disabled while running.)
      if (isExecuting(item)) {
        showToast('Chain already running', 'info', 1500);
        return;
      }
      // Defensive: a paused row's ⚡ button is disabled, but never force-fire a
      // disabled item even if the click slips through (pickNext filters it).
      if (item.disabled) return;
      // Session-level Pause is a HARD stop — the scheduler bails before any
      // force path runs (automationConfig.paused), so honor it here rather than
      // setting forceStart that would sit silently until Resume and then fire
      // unexpectedly. The button is disabled too; this is the belt-and-braces.
      if (automationConfig.paused) {
        showToast('Session automation paused — Resume to fire', 'info', 2200);
        return;
      }
      updateItem(sessionId, item.id, {
        forceStart: true,
        // Always start the chain from the top — clear any stale execution
        // cursor left over from a previous run.
        execState: undefined,
        execStepIdx: undefined,
      });
      const steps = totalChainSteps(item);
      showToast(
        steps > 1
          ? `Firing chain now — ${steps} steps in sequence…`
          : t === 'loop'
            ? 'Loop firing now…'
            : 'Scheduled prompt firing now…',
        'info',
        1800,
      );
    },
    [updateItem, sessionId, handleSendNow, automationConfig.paused],
  );

  // ---- Move to another session ----
  /** Single close path, so the anchor never outlives the open picker. */
  const closeMovePicker = useCallback(() => {
    setMovingItemId(null);
    setMoveAnchor(null);
  }, []);

  const handleMoveConfirm = useCallback(
    (targetSessionId: string) => {
      if (movingItemId === null) return;
      moveToSession([movingItemId], sessionId, targetSessionId);
      closeMovePicker();
      showToast('Prompt moved', 'info', 2000);
    },
    [movingItemId, sessionId, moveToSession, closeMovePicker],
  );

  // ---- Drag reorder ----
  // The grip is the drag source (so the row body stays selectable); the whole
  // row is shown as the drag ghost. Live reorder on dragover splices the dragged
  // row to the hovered index and calls `reorder()`, which reindexes `position`
  // (preserving each item's other fields incl. execState) and persists via the
  // store subscription. Dragging an in-flight chain item just moves its list
  // position; its execState is kept, so the scheduler never double-fires.
  const handleDragStart = useCallback(
    (e: React.DragEvent, item: QueueItem) => {
      setDraggingId(item.id);
      // Setting dataTransfer is REQUIRED for the drag to start in Firefox /
      // browser mode (Chromium/Electron is lenient); harmless everywhere else.
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(item.id)); } catch { /* ignore */ }
        // The grip is the drag handle, but drag the WHOLE row visually.
        const row = (e.currentTarget as HTMLElement).parentElement;
        if (row) { try { e.dataTransfer.setDragImage(row, 16, 12); } catch { /* ignore */ } }
      }
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, targetIdx: number) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (draggingId === null) return;
      // Derive the dragged row's CURRENT index by id every time, so a concurrent
      // scheduler add/remove that shifts the list can't splice the wrong row.
      const fromIdx = items.findIndex((i) => i.id === draggingId);
      if (fromIdx < 0 || fromIdx === targetIdx) return;
      // Immutable reorder: build new array without mutating
      const newItems = [...items];
      const [moved] = newItems.splice(fromIdx, 1);
      newItems.splice(targetIdx, 0, moved);
      // Validate array integrity
      if (newItems.length !== items.length) return;
      reorder(sessionId, newItems.map((i) => i.id));
    },
    [draggingId, items, reorder, sessionId],
  );

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
  }, []);

  // ---- Click/keyboard reorder (▲/▼) ----
  // A discoverable, keyboard-reachable alternative to the drag grip (native
  // HTML5 DnD has no keyboard path). Swaps the item one slot in `dir` and calls
  // the same `reorder()` the drag path uses — which re-stamps only `position`,
  // so an in-flight loop/schedule chain keeps its execState and never re-fires.
  const handleMove = useCallback(
    (item: QueueItem, dir: -1 | 1) => {
      const fromIdx = items.findIndex((i) => i.id === item.id);
      if (fromIdx < 0) return;
      const targetIdx = fromIdx + dir;
      if (targetIdx < 0 || targetIdx >= items.length) return;
      const newItems = [...items];
      const [moved] = newItems.splice(fromIdx, 1);
      newItems.splice(targetIdx, 0, moved);
      reorder(sessionId, newItems.map((i) => i.id));
    },
    [items, reorder, sessionId],
  );

  // ---- Other sessions for move picker ----
  const moveTargets: QueueMoveTarget[] = Array.from(sessions.entries())
    .filter(([id]) => id !== sessionId)
    .map(([id, s]) => ({ id, projectName: s.projectName, title: s.title }));

  return (
    <div className={`${styles.queuePanel}${collapsed ? ` ${styles.collapsed}` : ''}`}>
      {/* Toggle header */}
      <div className={styles.queueHeader}>
        <button
          className={styles.queueToggle}
          onClick={() => {
            const next = !collapsed;
            setCollapsed(next);
            try { localStorage.setItem('queue-panel-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
          }}
        >
          <span className={styles.queueToggleArrow}>&#x25B6;</span>
          QUEUE{' '}
          <span className={styles.queueCount}>({items.length})</span>
        </button>
        <button
          className={styles.queueHistoryBtn}
          onClick={(e) => { e.stopPropagation(); setHistoryOpen(true); }}
          title={historyCount > 0 ? `Queue history (${historyCount} saved)` : 'Queue history — save items to reuse them across sessions'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          {historyCount > 0 && (
            <span className={styles.queueHistoryBadge}>{historyCount}</span>
          )}
        </button>
        <button
          className={`${styles.autoEnterToggle} ${autoEnter ? styles.autoEnterOn : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            const next = !autoEnter;
            // Enabling Auto-Enter also flips Auto-send ON (handled in the store),
            // so a queued prompt is actually fired AND submitted. Surface that
            // when it changed something the user didn't directly click.
            const enabledAutoSend = next && !autoSend;
            setAutoEnter(sessionId, next);
            showToast(
              next
                ? enabledAutoSend
                  ? 'Auto-Enter ON — also enabled Auto-send, so prompts now send & submit automatically'
                  : 'Auto-Enter ON — prompts send & submit automatically'
                : 'Auto-Enter disabled — prompt typed only, press Enter yourself',
              'info',
              2200,
            );
          }}
          title={autoEnter
            ? 'Auto-Enter ON — prompt is typed AND submitted (real Enter keystroke)'
            : 'Auto-Enter OFF — prompt is typed only; press Enter yourself to submit'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" />
            <path d="M20 4v7a4 4 0 0 1-4 4H4" />
          </svg>
        </button>
        <button
          className={`${styles.autoSendToggle} ${autoSend ? styles.autoSendOn : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            const next = !autoSend;
            setAutoSend(sessionId, next);
            showToast(next ? 'Auto-send enabled' : 'Auto-send disabled', 'info', 1500);
          }}
          title={autoSend ? 'Auto-send ON — prompts sent automatically when session is waiting' : 'Auto-send OFF — prompts stay in queue'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className={styles.queueBody}>
        {/* Auto-send-off warning: shown whenever Auto-send is OFF so the user
            always sees WHY the Loop/Schedule pills are disabled — even before
            they've added any timed items. The wording shifts based on whether
            the queue already has existing timed items that won't fire. */}
        {!autoSend && (
          <div className={styles.queueAutoSendBanner}>
            <span>
              {items.some((it) => itemType(it) !== 'once')
                ? '⚠ Auto-send is OFF — Loop and Schedule items will not fire.'
                : '⚠ Auto-send is OFF — Loop and Schedule are disabled. Enable to unlock them.'}
            </span>
            <button
              className={styles.queueAutoSendBannerBtn}
              onClick={() => {
                setAutoSend(sessionId, true);
                showToast('Auto-send enabled', 'info', 1500);
              }}
            >
              Enable
            </button>
          </div>
        )}
        {/* Compose */}
        <div
          className={`${styles.queueCompose}${dragOver ? ` ${styles.queueComposeDragOver}` : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <AutocompleteTextarea
            className={styles.queueTextarea}
            placeholder="Add a prompt to the queue... (/ for commands, @ for files, Cmd+V for images)"
            rows={2}
            value={composeText}
            onChange={setComposeText}
            sessionId={sessionId}
            projectPath={currentProjectPath}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleAdd();
              }
            }}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.log"
            multiple
            style={{ display: 'none' }}
            onChange={handleImageFiles}
          />
          {/* Grouped so all four buttons wrap to a second line together instead
              of squeezing the textarea to an unusable sliver in a narrow panel. */}
          <div className={styles.queueComposeActions}>
          {/* Keep / insert a saved prompt. Two distinct marks on purpose: the
              single bookmark captures THIS text, the bookmark stack opens the
              library. Both are separate from the row-level ★, which saves a
              whole queue item (type + interval + chains) rather than text. */}
          <button
            className={`${styles.toolbarBtn} ${styles.queueSnippetBtn}${composeSnippetSaved ? ` ${styles.queueSnippetBtnOn}` : ''}`}
            onClick={() => { void handleKeepComposeText(); }}
            disabled={!composeText.trim()}
            title={
              composeSnippetSaved
                ? 'Already in saved prompts'
                : 'Keep this prompt for reuse in any prompt box'
            }
            aria-label="Keep prompt for reuse"
          >
            <BookmarkIcon filled={composeSnippetSaved} />
          </button>
          <button
            className={`${styles.toolbarBtn} ${styles.queueSnippetBtn}`}
            {...{ [SNIPPET_TRIGGER_ATTR]: 'compose' }}
            onClick={(e) =>
              setSnippetAnchor((prev) => (prev ? null : e.currentTarget))
            }
            aria-haspopup="dialog"
            aria-expanded={snippetAnchor !== null}
            title="Insert a saved prompt"
            aria-label="Insert a saved prompt"
          >
            <BookmarkStackIcon />
          </button>
          <button
            className={`${styles.toolbarBtn} ${styles.queueAttachBtn}`}
            onClick={handleImagePick}
            title="Attach images"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button
            className={`${styles.toolbarBtn} ${styles.queueAddBtn}`}
            onClick={handleAdd}
            disabled={!composeText.trim() && composeImages.length === 0}
          >
            ADD
          </button>
          </div>
          {snippetAnchor && (
            <PromptSnippetPicker
              anchor={snippetAnchor}
              onInsert={(text) => setComposeText((prev) => appendSnippet(prev, text))}
              onClose={() => setSnippetAnchor(null)}
            />
          )}
        </div>

        {/* Automation type selector — Once / Loop (interval) / Schedule (datetime).
            Loop/Schedule are gated on Auto-send because the scheduler short-
            circuits when Auto-send is OFF, so picking those types would just
            create dead items. */}
        <div className={styles.queueAutomationRow}>
          <div className={styles.queueTypePills}>
            {(['once', 'loop', 'schedule'] as QueueItemType[]).map((t) => {
              const requiresAutoSend = t !== 'once';
              const disabled = requiresAutoSend && !autoSend;
              return (
                <button
                  key={t}
                  className={`${styles.queueTypePill}${composeType === t ? ` ${styles.queueTypePillActive}` : ''}${disabled ? ` ${styles.queueTypePillDisabled}` : ''}`}
                  onClick={() => { if (!disabled) setComposeType(t); }}
                  disabled={disabled}
                  title={
                    disabled
                      ? 'Auto-send is OFF — enable it (✈ icon in the queue header) to use Loop/Schedule'
                      : t === 'once'
                        ? 'Fire once when session goes idle (default)'
                        : t === 'loop'
                          ? 'Repeat every N seconds/minutes/hours'
                          : 'Fire once at a specific date/time'
                  }
                >
                  {t === 'once' ? '★ Once' : t === 'loop' ? '⟳ Loop' : '🕐 Schedule'}
                </button>
              );
            })}
          </div>
          {composeType === 'loop' && (
            <span className={styles.queueIntervalGroup}>
              every
              <input
                type="number"
                min={1}
                className={styles.queueIntervalInput}
                value={composeIntervalValue}
                onChange={(e) => setComposeIntervalValue(Math.max(1, Number(e.target.value) || 1))}
              />
              <select
                className={styles.queueIntervalUnit}
                value={composeIntervalUnit}
                onChange={(e) => setComposeIntervalUnit(e.target.value as 'sec' | 'min' | 'hour')}
              >
                <option value="sec">sec</option>
                <option value="min">min</option>
                <option value="hour">hour</option>
              </select>
            </span>
          )}
          {composeType === 'schedule' && (
            <span className={styles.queueScheduleGroup}>
              at
              <input
                type="datetime-local"
                className={styles.queueScheduleInput}
                value={composeRunAt}
                onChange={(e) => setComposeRunAt(e.target.value)}
              />
            </span>
          )}
        </div>

        {composeImages.length > 0 && (
          <div className={styles.queueComposeImages}>
            {composeImages.map((img, i) => (
              <div key={i} className={styles.queueImageThumb}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  className={styles.queueImageRemove}
                  onClick={() => handleRemoveComposeImage(i)}
                  title="Remove image"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Queue list */}
        <div className={styles.queueList}>
          {items.length === 0 ? null : (
            items.map((item, idx) => (
              <div
                key={item.id}
                className={`${styles.queueItem}${draggingId === item.id ? ` ${styles.dragging}` : ''}${item.disabled ? ` ${styles.queueItemDisabled}` : ''}`}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={(e) => e.preventDefault()}
                onDragEnd={handleDragEnd}
              >
                <span
                  className={styles.queueDragHandle}
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                  role="button"
                  draggable
                  onDragStart={(e) => handleDragStart(e, item)}
                >
                  <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
                    <circle cx="2" cy="2" r="1" /><circle cx="6" cy="2" r="1" />
                    <circle cx="2" cy="7" r="1" /><circle cx="6" cy="7" r="1" />
                    <circle cx="2" cy="12" r="1" /><circle cx="6" cy="12" r="1" />
                  </svg>
                </span>
                <button
                  className={`${styles.queueToggleBtn}${item.disabled ? ` ${styles.queueToggleBtnOff}` : ` ${styles.queueToggleBtnOn}`}`}
                  onClick={(e) => { e.stopPropagation(); handleToggleEnabled(item); }}
                  title={item.disabled ? 'Paused — click to enable' : 'Enabled — click to pause'}
                  aria-label={item.disabled ? 'Enable item' : 'Pause item'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                    <line x1="12" y1="2" x2="12" y2="12" />
                  </svg>
                </button>
                <span className={styles.queuePos}>{idx + 1}</span>

                <div className={styles.queueTextCol}>
                  {item.text && <span className={styles.queueText}>{item.text}</span>}
                  {item.images && item.images.length > 0 && (
                    <div className={styles.queueItemImages}>
                      {item.images.map((img, i) => (
                        <div key={i} className={styles.queueItemThumb} title={img.name}>
                          <img src={img.dataUrl} alt={img.name} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Type chip + next-fire + chain badge */}
                {(() => {
                  const t = itemType(item);
                  const beforeCount = item.beforeChain?.length ?? 0;
                  const afterCount = item.afterChain?.length ?? 0;
                  const chained = beforeCount + afterCount > 0;
                  // A plain 'once' row has nothing to report. A CHAINED 'once'
                  // does — it shows its chain badge / step progress, but no type
                  // chip and no next-fire (it has no cadence, it drains on demand).
                  if (t === 'once' && !chained) return null;
                  const chipClass =
                    t === 'loop' ? styles.queueTypeChipLoop : styles.queueTypeChipSchedule;
                  const chipLabel =
                    t === 'loop'
                      ? `⟳ ${item.intervalMs ? formatInterval(item.intervalMs) : 'loop'}`
                      : '🕐 sched';
                  const total = totalChainSteps(item);
                  const cur = currentChainStep(item);
                  // Loops silenced by per-item or session-level quiet hours
                  // get "— in quiet hours —" instead of a misleading "due now".
                  const inQuietHours = isItemInQuietHours(
                    item,
                    automationConfig.loopExcludeWindows,
                    Date.now(),
                  );
                  // Daily-start clamp — only relevant for loops with a clamp
                  // set AND the current time is still before that clamp today.
                  const beforeDailyStart = isBeforeDailyStart(item, Date.now());
                  return (
                    <span className={styles.queueItemMeta}>
                      {t !== 'once' && (
                        <span className={`${styles.queueTypeChip} ${chipClass}`}>{chipLabel}</span>
                      )}
                      {item.disabled ? (
                        <span className={`${styles.queueNextFire} ${styles.queueNextFirePaused}`}>
                          — paused —
                        </span>
                      ) : isExecuting(item) ? (
                        <span className={styles.queueNextFire}>
                          step {cur}/{total}
                        </span>
                      ) : t === 'once' ? null : inQuietHours ? (
                        <span className={`${styles.queueNextFire} ${styles.queueNextFirePaused}`}>
                          — in quiet hours —
                        </span>
                      ) : beforeDailyStart ? (
                        <span className={`${styles.queueNextFire} ${styles.queueNextFirePaused}`}>
                          — waits until {formatClampDisplay(item.firstFireOfDay)} today —
                        </span>
                      ) : (
                        <span className={styles.queueNextFire}>{describeNextFire(item)}</span>
                      )}
                      {chained && !isExecuting(item) && !item.disabled && (
                        <span className={styles.queueNextFire}>
                          {/* On a 'once' row this badge leads the meta group,
                              so it must not open with a dangling separator. */}
                          {t !== 'once' ? '· ' : ''}
                          {beforeCount > 0 ? `${beforeCount} before` : ''}
                          {beforeCount > 0 && afterCount > 0 ? ' · ' : ''}
                          {afterCount > 0 ? `${afterCount} after` : ''}
                        </span>
                      )}
                      {(item.totalFires ?? 0) > 0 && (
                        <span className={styles.queueNextFire}>· {item.totalFires}×</span>
                      )}
                    </span>
                  );
                })()}

                {/* 7 buttons in fixed order — ▲ ▼ ★ SEND|⚡ NOW EDIT MOVE DEL
                    (the 4th slot is SEND for an unchained 'once' and ⚡ NOW for
                    everything else, never both). `.queueActions` wraps rather
                    than overflowing the row at narrow panel widths. */}
                <div className={styles.queueActions}>
                  <button
                    className={`${styles.queueActionBtn} ${styles.queueReorder}`}
                    onClick={() => handleMove(item, -1)}
                    disabled={idx === 0}
                    title="Move up"
                    aria-label="Move up"
                  >
                    ▲
                  </button>
                  <button
                    className={`${styles.queueActionBtn} ${styles.queueReorder}`}
                    onClick={() => handleMove(item, 1)}
                    disabled={idx === items.length - 1}
                    title="Move down"
                    aria-label="Move down"
                  >
                    ▼
                  </button>
                  <button
                    className={`${styles.queueFavBtn}${item.historyId != null ? ` ${styles.queueFavBtnOn}` : ''}`}
                    onClick={() => { void handleToggleFavorite(item); }}
                    title={
                      item.historyId != null
                        ? 'Saved to history — click to remove'
                        : 'Save to history — reuse this in other sessions later'
                    }
                    aria-label="Toggle favorite"
                  >
                    {item.historyId != null ? '★' : '☆'}
                  </button>
                  {/* A chained 'once' gets ⚡ NOW, not SEND: SEND flattens
                      the item to a single `item.text` write and removes it,
                      which would silently drop the configured chain. */}
                  {itemType(item) === 'once' && !hasChain(item) ? (
                    <button
                      className={`${styles.queueActionBtn} ${styles.queueSend}`}
                      onClick={() => handleSendNow(item)}
                      title="Send now (and remove)"
                    >
                      SEND
                    </button>
                  ) : (
                    <button
                      className={`${styles.queueActionBtn} ${styles.queueTriggerNow}`}
                      onClick={() => { void handleTriggerNow(item); }}
                      disabled={item.disabled || isExecuting(item) || automationConfig.paused}
                      title={
                        item.disabled
                          ? 'Paused — re-enable this item to fire it'
                          : isExecuting(item)
                            ? 'Chain already running…'
                            : automationConfig.paused
                              ? 'Session automation paused — Resume to fire'
                              : itemType(item) === 'loop'
                                ? 'Fire now — runs the full before→main→after chain in sequence, then restarts the cadence'
                                : 'Fire now — runs the full before→main→after chain in sequence, then removes'
                      }
                    >
                      ⚡ NOW
                    </button>
                  )}
                  {/* One editor for every type. This replaced BOTH the old
                      type-branching EDIT (inline textarea for 'once') and the
                      separate ⚙ button that existed only because EDIT couldn't
                      reach the modal for a 'once' item. */}
                  <button
                    className={`${styles.queueActionBtn} ${styles.queueEdit}`}
                    onClick={() => setChainEditId(item.id)}
                    title="Edit — prompt, type, before/after chain, images"
                  >
                    EDIT
                  </button>
                  <button
                    className={`${styles.queueActionBtn} ${styles.queueMove}`}
                    {...{ [MOVE_TRIGGER_ATTR]: item.id }}
                    onClick={(e) => {
                      // Capture the trigger before state flips — the picker
                      // measures its placement from this element's rect.
                      if (movingItemId === item.id) {
                        closeMovePicker();
                      } else {
                        setMoveAnchor(e.currentTarget);
                        setMovingItemId(item.id);
                      }
                    }}
                    aria-haspopup="listbox"
                    aria-expanded={movingItemId === item.id}
                    title="Move to another session"
                  >
                    MOVE
                  </button>
                  <button
                    className={`${styles.queueActionBtn} ${styles.queueDelete}`}
                    onClick={() => remove(sessionId, item.id)}
                    title="Remove"
                  >
                    DEL
                  </button>
                </div>

                {/* Move-to picker */}
                {movingItemId === item.id && (
                  <QueueMovePicker
                    anchor={moveAnchor}
                    targets={moveTargets}
                    onSelect={handleMoveConfirm}
                    onClose={closeMovePicker}
                  />
                )}
              </div>
            ))
          )}
        </div>

        {/* Automation status row — shown only when there's at least one
            time-based item so the queue stays uncluttered for plain Once use. */}
        {items.some((it) => itemType(it) !== 'once') && (() => {
          const sendable = isSendableStatus(sessionStatus);
          // True when the scheduler is silently held back by idle-guard and
          // the session isn't sendable — surface this whether the item is
          // in-flight OR just sitting at its due time. Without this widening,
          // a loop with nextFireAt in the past during a 'working' state shows
          // "due now · ..." next to "Loop active" with no explanation.
          const hasDueOrInflightItem = items.some((it) =>
            isExecuting(it) ||
            (itemType(it) !== 'once' && (it.nextFireAt ?? 0) <= Date.now()),
          );
          const blockedByIdleGuard =
            !automationConfig.paused &&
            automationConfig.idleGuard &&
            !sendable &&
            hasDueOrInflightItem;
          const blockedByPrompting =
            !automationConfig.paused &&
            automationConfig.skipWhenPrompting &&
            sessionStatus === 'prompting' &&
            hasDueOrInflightItem;
          // Status-row suffix gathers per-item pause + quiet-hours + daily-start
          // signals so a "Loop active" status doesn't lie when every loop is
          // currently silenced. Collapse into one parenthetical so suffixes
          // don't visually stack.
          const pausedCount = items.filter((it) => it.disabled && itemType(it) !== 'once').length;
          const nowMs = Date.now();
          const anyLoopInQuietHours = items.some(
            (it) =>
              itemType(it) === 'loop' &&
              !it.disabled &&
              isItemInQuietHours(it, automationConfig.loopExcludeWindows, nowMs),
          );
          const anyLoopBeforeDailyStart = items.some(
            (it) => !it.disabled && isBeforeDailyStart(it, nowMs),
          );
          const suffixParts: string[] = [];
          if (anyLoopInQuietHours) suffixParts.push('in quiet hours');
          if (anyLoopBeforeDailyStart) suffixParts.push('waiting for daily start');
          if (pausedCount > 0) suffixParts.push(`${pausedCount} paused`);
          const statusSuffix = suffixParts.length > 0 ? ` (${suffixParts.join(', ')})` : '';
          return (
          <div className={styles.queueStatusRow}>
            <span>
              {automationConfig.paused
                ? '⏸ Paused'
                : blockedByPrompting
                  ? '⏳ Holding fire — session is mid-prompt (skip-prompting on)'
                  : blockedByIdleGuard
                    ? `⏳ Waiting for session to be idle (status: ${sessionStatus})`
                    : items.some((it) => itemType(it) === 'loop')
                      ? `⟳ Loop active${statusSuffix}`
                      : `🕐 Scheduler armed${statusSuffix}`}
            </span>
            <button
              className={`${styles.queueStatusToggle}${automationConfig.paused ? ` ${styles.queueStatusToggleOn}` : ''}`}
              onClick={() => setPaused(sessionId, !automationConfig.paused)}
              title={automationConfig.paused ? 'Resume automation' : 'Pause all loop/schedule firing'}
            >
              {automationConfig.paused ? 'Resume' : 'Pause'}
            </button>
            <button
              className={`${styles.queueStatusToggle}${automationConfig.idleGuard ? ` ${styles.queueStatusToggleOn}` : ''}`}
              onClick={() => setIdleGuard(sessionId, !automationConfig.idleGuard)}
              title={
                automationConfig.idleGuard
                  ? 'Idle-guard ON — loop/schedule items wait for the session to be idle before firing'
                  : 'Idle-guard OFF — loop/schedule items fire at their scheduled time regardless of session state'
              }
            >
              Idle-guard {automationConfig.idleGuard ? 'on' : 'off'}
            </button>
            <button
              className={`${styles.queueStatusToggle}${automationConfig.skipWhenPrompting ? ` ${styles.queueStatusToggleOn}` : ''}`}
              onClick={() => setSkipWhenPrompting(sessionId, !automationConfig.skipWhenPrompting)}
              title={
                automationConfig.skipWhenPrompting
                  ? 'Skip-when-prompting ON — pause fires the moment the CLI is mid-prompt-submit, even if idle-guard is off'
                  : 'Skip-when-prompting OFF — fire even while the session is processing a fresh prompt (NOT recommended)'
              }
            >
              Skip-prompting {automationConfig.skipWhenPrompting ? 'on' : 'off'}
            </button>
            <button
              className={`${styles.queueStatusToggle}${(automationConfig.loopExcludeWindows?.length ?? 0) > 0 ? ` ${styles.queueStatusToggleOn}` : ''}`}
              onClick={() => setQuietHoursOpen(true)}
              title="Edit session-wide quiet hours — pause time ranges that apply to all loops in this session"
            >
              ⏰ Quiet hours
              {(automationConfig.loopExcludeWindows?.length ?? 0) > 0
                ? ` (${automationConfig.loopExcludeWindows!.length})`
                : ''}
            </button>
          </div>
          );
        })()}
      </div>
      {quietHoursOpen && (
        <LoopExcludeWindowsModal
          windows={automationConfig.loopExcludeWindows ?? []}
          onClose={() => setQuietHoursOpen(false)}
          onSave={(windows) => setLoopExcludeWindows(sessionId, windows)}
        />
      )}
      {chainEditId !== null && (() => {
        const target = items.find((i) => i.id === chainEditId);
        if (!target) {
          // Item was removed externally while modal was open — close it.
          if (chainEditId !== null) setChainEditId(null);
          return null;
        }
        return (
          <QueueItemEditModal
            item={target}
            autoSendEnabled={autoSend}
            sessionId={sessionId}
            projectPath={currentProjectPath}
            onClose={() => setChainEditId(null)}
            onSave={(patch) => updateItem(sessionId, target.id, patch)}
            onDelete={() => {
              remove(sessionId, target.id);
              setChainEditId(null);
            }}
          />
        );
      })()}
      <QueueHistorySheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        currentSessionId={sessionId}
        currentSessionTitle={currentSessionTitle}
      />
    </div>
  );
}
