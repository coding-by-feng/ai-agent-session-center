/**
 * Did the CLI actually take the prompt the queue just typed?
 *
 * The queue removes a `once` item the moment its Enter is written, and then
 * waits for a hook to say the turn started. Sometimes the Enter is swallowed:
 * Claude Code's TUI takes a pasted image path in slowly (~1.3 s idle, longer
 * while the SessionStart hooks of a `/clear` are running), and an Enter that
 * lands before it is done never submits. The text sits in the input box ("review
 * and press Enter to send"), no hook fires, and the rest of the queue waits on an
 * acknowledgement that cannot come. That is how a queued `/clear` followed by an
 * image prompt stalled the queue.
 *
 * So after a queue send the scheduler keeps a `PendingSubmit`, and while nothing
 * acknowledges the prompt it presses Enter again on a fixed schedule. An Enter in
 * an empty input box is a no-op, so a prompt the CLI did take (and is holding
 * while its hooks run) is not sent twice. Pure, so the decision table is tested
 * on its own; the scheduler hook owns the writes.
 */

/**
 * When to press Enter again, measured from the original Enter. The last retry
 * stays well inside the queue's 5-minute no-work fallback, after which the next
 * item would be typed on top of whatever is still sitting in the input box.
 */
export const SUBMIT_RETRY_AFTER_MS: readonly number[] = [3_000, 8_000, 15_000, 30_000, 60_000];

/**
 * How long after the last retry an unacknowledged send is reported as given up.
 * Gives that last Enter time to be acknowledged; the scheduler then tells the
 * user, because the queue cannot tell a prompt still in the input box from one
 * the CLI is holding (SessionStart hooks after a /clear ran 78 s once).
 */
export const SUBMIT_GIVE_UP_GRACE_MS = 15_000;

export interface PendingSubmit {
  /** The terminal the prompt was typed into. */
  terminalId: string;
  /** When the submitting Enter was written. */
  enterAt: number;
  /** `session.lastActivityAt` sampled before the send; a later stamp is a hook acknowledging it. */
  activityAtOpen?: number;
  /** Enters pressed again so far. */
  attempts: number;
}

/** What a tick sees of the session. */
export interface SubmitObservation {
  now: number;
  status: string;
  activityAt?: number;
  terminalId?: string | null;
  userCancelled: boolean;
  /** The session's Auto-Enter toggle now. Off means the user took over the input box. */
  autoEnter: boolean;
}

/**
 * Retry slots already passed `elapsedMs` after the Enter. Stored as the new
 * `attempts` after a retry, so a tick that runs late (a throttled window) presses
 * Enter once rather than once per missed slot.
 */
export function retriesElapsed(elapsedMs: number): number {
  return SUBMIT_RETRY_AFTER_MS.filter((after) => after <= elapsedMs).length;
}

/** Statuses in which an extra Enter can only submit what is in the input box. */
const RETRYABLE_STATUSES = new Set(['waiting', 'idle']);

/**
 * Whether a sent prompt is worth confirming. Never without Auto-Enter (the human
 * submits on purpose) and never for a slash command: `/model` or `/config` open
 * a picker, and an extra Enter there would choose an option.
 */
export function mayConfirmSubmit(text: string, autoEnter: boolean): boolean {
  return autoEnter && !text.trimStart().startsWith('/');
}

/**
 * - `done`: acknowledged (a hook stamp after the send, or a busy status), or no
 *   longer safe to press Enter (a question or approval dialog, the session ended
 *   or reconnected, the user cancelled or switched Auto-Enter off, the terminal
 *   changed).
 * - `retry`: still unacknowledged, sitting `waiting`/`idle`, and the next retry
 *   is due.
 * - `wait`: still unacknowledged, but the next retry (or the give-up) is not due.
 * - `give-up`: every retry was pressed and the grace after the last one passed
 *   with no acknowledgement — the caller tells the user.
 */
export function submitRetryDecision(
  pending: PendingSubmit,
  seen: SubmitObservation,
): 'retry' | 'wait' | 'done' | 'give-up' {
  if (
    pending.activityAtOpen !== undefined &&
    seen.activityAt !== undefined &&
    seen.activityAt > pending.activityAtOpen
  ) {
    return 'done';
  }
  if (seen.userCancelled || !seen.autoEnter || seen.terminalId !== pending.terminalId) return 'done';
  if (!RETRYABLE_STATUSES.has(seen.status)) return 'done';
  const elapsed = seen.now - pending.enterAt;
  const dueAfter = SUBMIT_RETRY_AFTER_MS[pending.attempts];
  if (dueAfter === undefined) {
    const last = SUBMIT_RETRY_AFTER_MS[SUBMIT_RETRY_AFTER_MS.length - 1];
    return elapsed >= last + SUBMIT_GIVE_UP_GRACE_MS ? 'give-up' : 'wait';
  }
  return elapsed >= dueAfter ? 'retry' : 'wait';
}
