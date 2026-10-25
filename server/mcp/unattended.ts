// unattended.ts — Ruling 42: a central starts no unattended run in a session it did not open itself (P4-12: in its own
// workers, workers.ts, it may).
//
// A queued prompt that is turned on, auto-send, auto-enter and the auto-resume watchdog make the AASC window type into a
// session without anyone asking. That is how a central could get work done in a person's session while nobody watches,
// so a central may not turn any of them ON, nor ⚡ NOW a prompt (it would run at once), in a session it did not open.
// Turning one OFF, pausing, and every change that starts no send stay allowed.
//
// Rulings 43, 52 and 53 close the side doors to the same thing. The window sends a prompt that is on by itself, so
// changing what it says, when it runs, its chain, or where it stands among the prompts that are on is refused too
// (`isEnabledPrompt`, `reordersEnabled`); the same change to a prompt that is off stays allowed, since a person turns it
// on. So are resuming a paused queue, releasing the hold a person's cancel put on it, and the rules that loosen when or
// what the window sends: the idle guard or the prompting hold turned off, a new resume prompt (`loosensAutomation`),
// quiet hours taken away (`onlyAddsQuietHours`) and more resume attempts (`raisesResumeRetries`).
//
// `assertMayStartUnattended` is the one place that says no. P4 relaxes it here and nowhere else (Ruling P4-12): for a
// session the central opened itself (its own worker, `isOwnWorker`) it returns instead of refusing, whatever the change,
// and the steering rails of `ctx.mayDrive` still apply after it; for every other session it refuses. The queue write
// tools call it first, before the rails, so a call that can never work is not answered with a refusal that says "try again"
// (HUMAN_ACTIVE, BUSY). A lock that depends on the stored queue (a prompt that is on, the quiet hours, the attempts) can
// only be checked once the queue is read, so it is checked in the write's read-modify-write, after the rails.
//
// The refusal is DENIED, with a hint that tells the person what to do. Its words name neither the session nor anything a
// caller sent. It is a `SteerRefusal`, so it carries the session for the activity log.

import type { Session } from '../../src/types/session.js';
import { SteerRefusal } from './policy.js';
import { inOrder, storedResumeRetries, type QueueAutomationLike, type QueueItemLike, type WindowInput } from './queueOps.js';
import type { ToolContext } from './registry.js';

/** What the person is told, word for word (Ruling 42). */
export const UNATTENDED_HINT = 'Only you can turn this on in AASC; a central can do it only in a session it opened itself';

/** The automation switches that, turned ON, make the window send into a session without being asked. */
export const UNATTENDED_SWITCHES = ['autoSend', 'autoEnter', 'autoResume'] as const;

/** The guards that, turned OFF, let the window send at a time it now waits (Ruling 43). */
export const UNATTENDED_GUARDS = ['idleGuard', 'skipWhenPrompting'] as const;

type UnattendedSwitch = (typeof UNATTENDED_SWITCHES)[number];
type UnattendedGuard = (typeof UNATTENDED_GUARDS)[number];

/**
 * What a refused change does, which is what its words say: it starts unattended sends (Ruling 42), it changes a prompt
 * that is on (Ruling 43), or it loosens when or what the window sends by itself (Rulings 43 and 53).
 */
export type UnattendedChange = 'start' | 'enabledPrompt' | 'loosen';

const REFUSALS: Readonly<Record<UnattendedChange, { message: string; hint: string }>> = {
  start: {
    message: 'A central does not start unattended runs in a session it did not open.',
    hint: UNATTENDED_HINT,
  },
  enabledPrompt: {
    message: 'That prompt is on, so changing it would change what AASC sends into the session by itself.',
    hint: 'Turn it off first (queue_set_item_enabled), then change it: once a central has changed it, only a person can turn it back on, in AASC.',
  },
  loosen: {
    message: 'That would loosen when or what AASC sends into the session by itself, which a central does not do in a session it did not open.',
    hint: 'Only you can change this in AASC; a central can do it only in a session it opened itself',
  },
};

/** Does this change turn one of the switches ON? Turning one off, or leaving it out, never does. */
export function turnsOnUnattended(change: Partial<Record<UnattendedSwitch, boolean | undefined>>): boolean {
  return UNATTENDED_SWITCHES.some((name) => change[name] === true);
}

/** Is this session one the calling central opened itself, and still its own (workers.ts)? */
export const isOwnWorker = (ctx: ToolContext, session: Session): boolean => ctx.workers.isOwn(ctx.central.centralId, session);

/**
 * Refuses (DENIED) to let a central make this change in this session: start an unattended run (`start`, the default),
 * change a prompt that is on, or loosen how the window sends by itself. Returns for the central's own worker (P4-12),
 * whatever the change; refuses for every other session.
 */
export function assertMayStartUnattended(ctx: ToolContext, session: Session, change: UnattendedChange = 'start'): void {
  if (isOwnWorker(ctx, session)) return;
  const { message, hint } = Object.hasOwn(REFUSALS, change) ? REFUSALS[change] : REFUSALS.start;
  throw new SteerRefusal('DENIED', message, hint, session.sessionId);
}

// ---------------------------------------------------------------------------
// Which changes go through the lock (Rulings 43 and 53)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Is a prompt with this id in the queue and on? The scheduler skips only one marked `disabled: true`. */
export function isEnabledPrompt(items: readonly QueueItemLike[], itemId: number): boolean {
  return items.some((entry) => isRecord(entry) && entry.id === itemId && entry.disabled !== true);
}

/** The ids of the prompts that are on, in the order the window takes them. */
const enabledOrder = (items: readonly QueueItemLike[]): unknown[] =>
  inOrder(items)
    .filter((entry) => isRecord(entry) && entry.disabled !== true)
    .map((entry) => entry.id);

/** Does every prompt carry a position? The window sorts by it, so without one its order cannot be told from here. */
const allPlaced = (items: readonly QueueItemLike[]): boolean =>
  items.every((entry) => !isRecord(entry) || (typeof entry.position === 'number' && Number.isFinite(entry.position)));

/**
 * Do the prompts that are on stand in another order after this change, or is one more or one fewer on? A queue with a
 * prompt that has no position counts as reordered: the order the window gave it cannot be told.
 */
export function reordersEnabled(before: readonly QueueItemLike[], after: readonly QueueItemLike[]): boolean {
  if (!allPlaced(before) || !allPlaced(after)) return true;
  const was = enabledOrder(before);
  const now = enabledOrder(after);
  return was.length !== now.length || was.some((id, i) => id !== now[i]);
}

/** `H:MM` or `HH:MM` as minutes since midnight, as the scheduler reads a quiet-hours time (`parseHHMM`); null if not one. */
function minutesOf(v: unknown): number | null {
  const m = typeof v === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(v) : null;
  if (m === null) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

/** A window as the scheduler keeps it, or null for one it ignores (a time it cannot read, or one that starts where it ends). */
function windowKey(start: unknown, end: unknown): string | null {
  const from = minutesOf(start);
  const to = minutesOf(end);
  return from === null || to === null || from === to ? null : `${from}-${to}`;
}

/** The session's quiet hours for every loop, as the scheduler keeps them. */
function storedQuietHours(automation: QueueAutomationLike | null): string[] {
  const list = isRecord(automation) && Array.isArray(automation.loopExcludeWindows) ? automation.loopExcludeWindows : [];
  return list.map((w) => (isRecord(w) ? windowKey(w.startHHMM, w.endHHMM) : null)).filter((key): key is string => key !== null);
}

/**
 * Does `next` only add quiet hours to the session's? Every window the scheduler keeps now must still be in it, as often
 * as it is stored: a window taken away, or with other times, lets loops start when they would not have.
 */
export function onlyAddsQuietHours(automation: QueueAutomationLike | null, next: ReadonlyArray<WindowInput>): boolean {
  const offered = new Map<string, number>();
  for (const w of next) {
    const key = windowKey(w.start, w.end);
    if (key !== null) offered.set(key, (offered.get(key) ?? 0) + 1);
  }
  for (const key of storedQuietHours(automation)) {
    const left = offered.get(key) ?? 0;
    if (left === 0) return false;
    offered.set(key, left - 1);
  }
  return true;
}

/** Would `requested` resume attempts be more than the session allows now? The same number, or fewer, never are. */
export function raisesResumeRetries(automation: QueueAutomationLike | null, requested: number): boolean {
  return requested > storedResumeRetries(automation);
}

/** Does this change loosen how the window sends by itself: a guard turned off, or any new resume prompt (Ruling 43)? */
export function loosensAutomation(change: Partial<Record<UnattendedGuard, boolean | undefined>> & { resumePrompt?: string }): boolean {
  return UNATTENDED_GUARDS.some((name) => change[name] === false) || change.resumePrompt !== undefined;
}
