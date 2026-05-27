/**
 * Pure scheduling helpers for the prompt queue.
 *
 * Priority rule:
 *   0. If any item is mid-execution (execState ∈ before/main/after), keep
 *      firing IT until the chain completes — chains are atomic relative to
 *      other items.
 *   1. Any item with type 'once' (or no type) fires next — `nextFireAt` is 0.
 *   2. Among 'loop' and 'schedule', the one with the earliest `nextFireAt`
 *      that is ≤ now wins.
 *
 * The caller is responsible for checking pause state, the idle-guard, and
 * actually sending the prompt — this module never touches the DOM or fetch.
 */
import type { ChainStep, ChainExecState, ExcludeWindow, QueueItem, QueueItemType } from '@/stores/queueStore';

/**
 * Treat anything without an explicit `type` as 'once' so legacy queue rows
 * keep their previous behaviour after migration.
 */
export function itemType(item: QueueItem): QueueItemType {
  return item.type ?? 'once';
}

/** Effective next-fire timestamp; 'once' items always sort first. */
export function effectiveNextFireAt(item: QueueItem): number {
  if (itemType(item) === 'once') return 0;
  return item.nextFireAt ?? 0;
}

/** True when the item is mid-execution of a chain (not idle). */
export function isExecuting(item: QueueItem): boolean {
  const s = item.execState;
  return s === 'before' || s === 'main' || s === 'after';
}

/** Parse a 'HH:MM' string into total minutes since midnight (0..1439).
 *  Returns null when the input is malformed. */
function parseHHMM(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * True when `nowMs` falls inside any of the time-of-day windows on the item.
 *
 * Windows use local-time HH:MM. A window with start > end wraps midnight; a
 * window with start === end is invalid and ignored (so a misconfigured row
 * never silently blocks the loop forever).
 */
export function isInExcludeWindow(
  windows: ExcludeWindow[] | undefined,
  nowMs: number,
): boolean {
  if (!windows || windows.length === 0) return false;
  const d = new Date(nowMs);
  const minutes = d.getHours() * 60 + d.getMinutes();
  for (const w of windows) {
    const start = parseHHMM(w.startHHMM);
    const end = parseHHMM(w.endHHMM);
    if (start === null || end === null || start === end) continue;
    if (start < end) {
      // same-day window: [start, end)
      if (minutes >= start && minutes < end) return true;
    } else {
      // wrap-midnight window: [start, 1440) ∪ [0, end)
      if (minutes >= start || minutes < end) return true;
    }
  }
  return false;
}

/**
 * Return what should be sent to the terminal RIGHT NOW for this item.
 *
 * - If the item is already mid-chain (execState ∈ before/after), return that
 *   step's text+images.
 * - Otherwise (idle / undefined / 'main'), an item that HAS a before-chain
 *   sends `beforeChain[0]` first; an item without a before-chain sends its
 *   own main prompt.
 *
 * A corrupted execStepIdx falls back to the main prompt so the queue never
 * deadlocks on a stale row.
 */
/**
 * True when the session's current status indicates the CLI prompt box is
 * ready to receive a new prompt. 'idle' is included because slash commands
 * (/clear, /compact) and post-2-minute auto-idle leave the session in this
 * state while the CLI is still ready to receive input.
 */
export function isSendableStatus(status: string): boolean {
  return status === 'waiting' || status === 'input' || status === 'idle';
}

export function getActiveStep(item: QueueItem): { text: string; images?: ChainStep['images'] } {
  const idx = item.execStepIdx ?? 0;
  if (item.execState === 'before') {
    const step = item.beforeChain?.[idx];
    if (step) return { text: step.text, images: step.images };
  }
  if (item.execState === 'after') {
    const step = item.afterChain?.[idx];
    if (step) return { text: step.text, images: step.images };
  }
  // Idle / undefined / 'main'
  if (!isExecuting(item) && (item.beforeChain?.length ?? 0) > 0) {
    const step = item.beforeChain![0];
    return { text: step.text, images: step.images };
  }
  return { text: item.text, images: item.images };
}

/**
 * Pick the next item to fire, applying the priority rule.
 * Returns null when nothing is due.
 *
 * - `now` is unix ms (passed in for testability)
 * - `sessionWaiting` is true when the CLI is in waiting/input state
 * - `idleGuard` when true makes loop+schedule items hold until idle; 'once'
 *   items are always allowed to fire as soon as the session is idle.
 */
export function pickNext(
  items: QueueItem[],
  now: number,
  sessionWaiting: boolean,
  idleGuard: boolean,
  /**
   * Session-level loop quiet hours. OR'd with each item's own
   * `excludeWindows` — a loop cycle won't start if NOW falls in EITHER list.
   * In-flight chains are unaffected (chain atomicity is more important than
   * starting-edge precision).
   */
  sessionExcludeWindows?: ExcludeWindow[],
  /**
   * Independent of idleGuard. When true, ALL queue fires are blocked
   * regardless of which priority bucket they came from. The caller computes
   * this from `(session.status === 'prompting' && config.skipWhenPrompting)`.
   * Useful for the user who runs with idleGuard=OFF (loops fire mid-tool)
   * but still doesn't want to interrupt the brief moment right after they
   * just submitted a prompt.
   */
  blockedByPrompting?: boolean,
): QueueItem | null {
  if (items.length === 0) return null;
  // Per-item disable. Filtered up-front so in-flight detection, once-drain,
  // and loop/schedule selection all behave as if disabled items don't exist.
  // We intentionally DON'T resume a chain on a row that became disabled
  // mid-flight — the user paused it, so wait for them to re-enable.
  const active = items.filter((it) => !it.disabled);
  if (active.length === 0) return null;
  items = active;
  // Hard short-circuit: if the prompting-guard is asking us to wait, no
  // item in any priority bucket should fire. This is checked BEFORE
  // PRIORITY 0 so even in-flight chains pause for one tick rather than
  // type over the just-submitted prompt.
  if (blockedByPrompting) return null;

  // PRIORITY 0: keep firing any in-flight chain until completion. Chains are
  // atomic relative to other items so the user-defined before→main→after
  // sequence is never interleaved with other prompts.
  const inFlight = items.find((it) => isExecuting(it));
  if (inFlight) {
    // The chain still respects idle-guard (we don't want to spam the CLI mid-
    // tool just because a chain happens to be in progress).
    if (idleGuard && !sessionWaiting) return null;
    return inFlight;
  }

  // PRIORITY 1: drain 'once' items first — but ONLY when the session is
  // idle. Once items always need the CLI to be waiting (they're typed prompts,
  // not automation). If the session is busy we MUST fall through so that a
  // loop/schedule item with idleGuard=false isn't blocked behind a stuck once
  // item.
  const onceItem = items.find((it) => itemType(it) === 'once');
  if (onceItem && sessionWaiting) {
    return onceItem;
  }

  // PRIORITY 2: pick the earliest-due loop/schedule item.
  let best: QueueItem | null = null;
  for (const it of items) {
    const t = itemType(it);
    if (t !== 'loop' && t !== 'schedule') continue;
    const due = effectiveNextFireAt(it);
    if (due > now) continue;
    if (idleGuard && !sessionWaiting) continue;
    // Time-of-day exclusion only applies to loops (schedules are explicit
    // one-shot times — the user already chose when it should fire). An
    // in-flight chain is unreachable here (it'd have been caught in
    // PRIORITY 0), so this is always a fresh cycle start. Session-level
    // quiet hours are OR'd with the item's own list so a session-wide
    // "no nights" rule can coexist with a per-item lunch break.
    if (
      t === 'loop' &&
      (isInExcludeWindow(it.excludeWindows, now) ||
        isInExcludeWindow(sessionExcludeWindows, now))
    ) {
      continue;
    }
    if (best === null || effectiveNextFireAt(it) < effectiveNextFireAt(best)) {
      best = it;
    }
  }
  return best;
}

/**
 * Produce the action to apply after a successful fire.
 *
 *   'continue'   — chain has more steps; patch advances execState/execStepIdx
 *   'remove'     — item is done (once / one-shot schedule)
 *   'reschedule' — loop completed a full chain; patch sets next-fire time
 *
 * The chain advances in this order for time-based items:
 *
 *   idle (or undefined) ┐
 *                       ├─→ before (steps 0..N-1) ─→ main ─→ after (steps 0..M-1) ─→ COMPLETE
 *                       │   (skipped if no before)         (skipped if no after)
 *                       └─→ main directly when no before
 *
 * Once items have no chain — `idle` advance goes straight to COMPLETE / remove.
 * A loop with no intervalMs (corrupted row) is removed to avoid tight resend.
 */
export function advanceAfterFire(
  item: QueueItem,
  now: number,
):
  | { action: 'remove' }
  | { action: 'continue'; patch: Partial<QueueItem> }
  | { action: 'reschedule'; patch: Partial<QueueItem> } {
  const type = itemType(item);
  const before = item.beforeChain ?? [];
  const after = item.afterChain ?? [];

  // ---- compute the next chain position ---------------------------------
  // Treat undefined/idle as "we just sent the FIRST step" — figure out what
  // came next. The phase we land in determines whether the chain completes.
  let nextPhase: ChainExecState | 'done';
  let nextIdx = 0;

  switch (item.execState) {
    case 'before': {
      const idx = (item.execStepIdx ?? 0) + 1;
      if (idx < before.length) {
        nextPhase = 'before';
        nextIdx = idx;
      } else {
        nextPhase = 'main';
        nextIdx = 0;
      }
      break;
    }
    case 'main': {
      if (after.length > 0) {
        nextPhase = 'after';
        nextIdx = 0;
      } else {
        nextPhase = 'done';
      }
      break;
    }
    case 'after': {
      const idx = (item.execStepIdx ?? 0) + 1;
      if (idx < after.length) {
        nextPhase = 'after';
        nextIdx = idx;
      } else {
        nextPhase = 'done';
      }
      break;
    }
    case 'idle':
    case undefined:
    default: {
      // We just fired the implicit "start" of this execution. If the chain has
      // a before-block we entered IT, otherwise we fired the main prompt.
      // Either way we're now positioned at the next slot.
      if (before.length > 0) {
        if (before.length > 1) {
          nextPhase = 'before';
          nextIdx = 1;
        } else {
          // single before step → next is main
          nextPhase = 'main';
          nextIdx = 0;
        }
      } else {
        // we just fired main directly
        if (after.length > 0) {
          nextPhase = 'after';
          nextIdx = 0;
        } else {
          nextPhase = 'done';
        }
      }
      break;
    }
  }

  // ---- mid-chain: keep going ------------------------------------------
  if (nextPhase !== 'done') {
    return {
      action: 'continue',
      patch: { execState: nextPhase, execStepIdx: nextIdx },
    };
  }

  // ---- chain complete: terminate or reschedule ------------------------
  const totalFires = (item.totalFires ?? 0) + 1;
  const completePatch: Partial<QueueItem> = {
    execState: 'idle',
    execStepIdx: undefined,
    lastFiredAt: now,
    totalFires,
  };

  if (type === 'once') return { action: 'remove' };
  if (type === 'schedule') return { action: 'remove' };
  if (type === 'loop') {
    if (!item.intervalMs || item.intervalMs <= 0) return { action: 'remove' };
    return {
      action: 'reschedule',
      patch: { ...completePatch, nextFireAt: now + item.intervalMs },
    };
  }
  return { action: 'remove' };
}

/**
 * When the scheduler is being blocked by `skipWhenPrompting`, any loop items
 * that are currently due lose this cycle entirely — we don't want them to
 * pile up as "due now" indefinitely while the user is mid-prompt-submit.
 * This returns the patches that should be applied to advance each due loop's
 * `nextFireAt` to the next interval so the UI countdown rolls forward.
 *
 *  - Only `loop` items qualify. Schedule items use a user-chosen runAt and
 *    keep their original time even if missed (the user can decide what to do).
 *  - Items already mid-chain (`isExecuting`) are skipped — chain atomicity
 *    means we shouldn't bump their cadence just because the start of the
 *    NEXT cycle missed its window; the chain will finish first.
 *  - Items with no `intervalMs` are skipped (corrupted rows).
 *  - `totalFires` is NOT incremented — the cycle was skipped, not fired.
 */
export function advanceBlockedLoops(
  items: QueueItem[],
  now: number,
): Array<{ id: number; patch: Partial<QueueItem> }> {
  const out: Array<{ id: number; patch: Partial<QueueItem> }> = [];
  for (const it of items) {
    if (itemType(it) !== 'loop') continue;
    if (isExecuting(it)) continue;
    // Disabled loops have their nextFireAt frozen until the user re-enables.
    // Without this guard, a paused-during-skip-prompting loop would silently
    // roll forward and lose its scheduled offset for no user-visible reason.
    if (it.disabled) continue;
    const due = effectiveNextFireAt(it);
    if (due > now) continue;
    const intervalMs = it.intervalMs ?? 0;
    if (intervalMs <= 0) continue;
    out.push({ id: it.id, patch: { nextFireAt: now + intervalMs } });
  }
  return out;
}

/**
 * Decide what execState a freshly-picked (idle) item should be in BEFORE it
 * fires its first step — i.e. which prompt should be sent on this tick.
 * Returns `null` if the item is already mid-execution (the caller should use
 * the item's existing execState).
 */
export function startExecution(item: QueueItem): {
  execState: ChainExecState;
  execStepIdx: number;
} | null {
  if (isExecuting(item)) return null;
  if ((item.beforeChain?.length ?? 0) > 0) {
    return { execState: 'before', execStepIdx: 0 };
  }
  return { execState: 'main', execStepIdx: 0 };
}

/**
 * Build the runtime defaults applied when a new typed item is added.
 * Ensures 'once' items have nextFireAt=0 so the priority sort is stable.
 */
export function applyTypeDefaults(
  base: Omit<QueueItem, 'type' | 'nextFireAt'>,
  type: QueueItemType,
  options: { intervalMs?: number; runAt?: number },
): QueueItem {
  if (type === 'once') {
    return { ...base, type, nextFireAt: 0 };
  }
  if (type === 'loop') {
    const intervalMs = options.intervalMs && options.intervalMs > 0 ? options.intervalMs : 60_000;
    return {
      ...base,
      type,
      intervalMs,
      // First fire happens one interval after the item is added.
      nextFireAt: Date.now() + intervalMs,
      totalFires: 0,
    };
  }
  // schedule
  const runAt = options.runAt ?? Date.now() + 60_000;
  return { ...base, type, runAt, nextFireAt: runAt, totalFires: 0 };
}

/**
 * Total step count across before-chain + main + after-chain.
 * 1 when no chains are configured.
 */
export function totalChainSteps(item: QueueItem): number {
  return 1 + (item.beforeChain?.length ?? 0) + (item.afterChain?.length ?? 0);
}

/**
 * Position of the currently-executing step in the flat 1..N sequence
 * (1-indexed). Returns 0 when the item is not executing.
 */
export function currentChainStep(item: QueueItem): number {
  if (!isExecuting(item)) return 0;
  const before = item.beforeChain?.length ?? 0;
  switch (item.execState) {
    case 'before':
      return (item.execStepIdx ?? 0) + 1;
    case 'main':
      return before + 1;
    case 'after':
      return before + 1 + (item.execStepIdx ?? 0) + 1;
    default:
      return 0;
  }
}

/**
 * Human-readable next-fire description.
 *
 * - **once**: "next when idle"
 * - **loop**: countdown (e.g. "in 5m 12s") — the user wants to see exactly
 *   when the next cycle will run
 * - **schedule**: absolute date/time (e.g. "May 26, 13:40") — schedules are
 *   "set and forget" so showing a ticking countdown is just noise; the
 *   user already chose the time, so just show it back
 */
export function describeNextFire(item: QueueItem, now = Date.now()): string {
  const type = itemType(item);
  if (type === 'once') return 'next when idle';
  const t = effectiveNextFireAt(item);
  if (!t) return '—';

  if (type === 'schedule') {
    // Always show the configured fire time as-is. If it's already past,
    // mark it overdue so the user knows the scheduler is trying to catch up.
    const formatted = new Date(t).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return t <= now ? `${formatted} (overdue)` : formatted;
  }

  // type === 'loop' → live countdown
  const deltaMs = t - now;
  if (deltaMs <= 0) return 'due now';
  if (deltaMs < 60_000) return `in ${Math.ceil(deltaMs / 1000)}s`;
  if (deltaMs < 3_600_000) {
    const m = Math.floor(deltaMs / 60_000);
    const s = Math.floor((deltaMs % 60_000) / 1000);
    return s > 0 ? `in ${m}m ${s}s` : `in ${m}m`;
  }
  if (deltaMs < 86_400_000) {
    const h = Math.floor(deltaMs / 3_600_000);
    const m = Math.floor((deltaMs % 3_600_000) / 60_000);
    return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format an interval (ms) as "10m", "1h", "30s", "2h 30m". */
export function formatInterval(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
