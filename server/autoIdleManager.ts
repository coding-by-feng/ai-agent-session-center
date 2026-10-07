/**
 * @module autoIdleManager
 * Transitions sessions to idle/waiting after configurable inactivity timeouts.
 * Prevents sessions from being stuck in transient states (prompting, working, approval)
 * when hooks are missed or the user abandons the session. Also cleans up stale pendingResume entries.
 */
import { AUTO_IDLE_TIMEOUTS } from './config.js';
import { SESSION_STATUS, ANIMATION_STATE, WS_TYPES } from './constants.js';
import log from './logger.js';
import { terminalLastOutputAt } from './terminalActivity.js';
import type { Session, PendingResume } from '../src/types/session.js';
import type { ServerMessage } from '../src/types/websocket.js';

let idleInterval: ReturnType<typeof setInterval> | null = null;
let pendingResumeCleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the auto-idle check interval.
 * Transitions sessions to idle/waiting if no activity for configured durations.
 *
 * These transitions run on the server's own clock — no hook event is behind them — so nothing else
 * tells a browser (or dirties the snapshot cache a reconnecting browser is served from). The tick
 * hands the sessions it ANNOUNCES to `onChange` in ONE call, after the whole pass, so the caller can
 * invalidate once and broadcast each.
 *
 * Only two decays are announced, because only they are both right to show and safe to act on:
 *  - `prompting → waiting` (a prompt that never ran: hook AND terminal silent) — without it the badge
 *    stayed "prompting" for good, and the queue never learned its turn was over;
 *  - `waiting → idle` (five minutes unreviewed) — the CLI really is at rest, and both are sendable.
 * The SAFETY NETS stay silent: `approval`/`input` → idle (10 min) and `working` → idle (15 min) are
 * guesses for a lost hook, and far more often wrong than right — the user is simply away with the
 * permission dialog still up, or a tool is running silently. Announcing them would flip a pending
 * approval's badge to "Idle" (hiding the request) and hand the queue an `idle` it treats as sendable,
 * typing the next prompt into the dialog. The server still holds them as idle internally.
 */
export function startAutoIdle(
  sessions: Map<string, Session>,
  onChange?: (changed: Session[]) => void,
): void {
  if (idleInterval) return;

  idleInterval = setInterval(() => {
    const now = Date.now();
    const announce: Session[] = [];
    for (const [_id, session] of sessions) {
      if (session.status === SESSION_STATUS.ENDED || session.status === SESSION_STATUS.IDLE) continue;
      const elapsed = now - session.lastActivityAt;

      if (session.status === SESSION_STATUS.APPROVAL && elapsed > AUTO_IDLE_TIMEOUTS.approval) {
        session.status = SESSION_STATUS.IDLE;
        session.animationState = ANIMATION_STATE.IDLE;
        session.emote = null;
        session.pendingTool = null;
        session.pendingToolDetail = null;
        session.waitingDetail = null;
      } else if (session.status === SESSION_STATUS.INPUT && elapsed > AUTO_IDLE_TIMEOUTS.input) {
        session.status = SESSION_STATUS.IDLE;
        session.animationState = ANIMATION_STATE.IDLE;
        session.emote = null;
        session.pendingTool = null;
        session.pendingToolDetail = null;
        session.waitingDetail = null;
      } else if (session.status === SESSION_STATUS.PROMPTING) {
        // Hook silence alone cannot tell a prompt that never ran (e.g. blocked
        // by a UserPromptSubmit hook — no Stop will ever come) from a turn
        // that is busy without firing hooks: Claude thinking or writing before
        // its first tool call, or the whole turn at Low hook density. `waiting`
        // is the prompt queue's "turn finished" signal, so decaying a live turn
        // made the queue send its next prompt into it. A live turn keeps
        // printing; a prompt that never ran does not — so the terminal must
        // have gone quiet too. Sessions without an AASC terminal (external
        // cards) have no output to read and keep the hook-only rule.
        //
        // No time limit while it prints. A 15-minute flip to idle was tried:
        // idle is sendable for a queue item with no open gate, so the next
        // queued prompt landed in the running turn.
        const lastOutput = terminalLastOutputAt(session.terminalId);
        const quietFor = lastOutput === undefined ? Infinity : now - lastOutput;
        if (elapsed > AUTO_IDLE_TIMEOUTS.prompting && quietFor > AUTO_IDLE_TIMEOUTS.prompting) {
          session.status = SESSION_STATUS.WAITING;
          session.animationState = ANIMATION_STATE.WAITING;
          session.emote = null;
          announce.push(session);
        }
      } else if (session.status === SESSION_STATUS.WAITING && elapsed > AUTO_IDLE_TIMEOUTS.waiting) {
        session.status = SESSION_STATUS.IDLE;
        session.animationState = ANIMATION_STATE.IDLE;
        session.emote = null;
        announce.push(session);
      } else if (session.status !== SESSION_STATUS.WAITING
        && session.status !== SESSION_STATUS.APPROVAL && session.status !== SESSION_STATUS.INPUT
        && session.status !== SESSION_STATUS.CONNECTING
        && elapsed > AUTO_IDLE_TIMEOUTS.working) {
        session.status = SESSION_STATUS.IDLE;
        session.animationState = ANIMATION_STATE.IDLE;
        session.emote = null;
      }
    }
    if (announce.length > 0 && onChange) {
      // A failing handler must not stop the interval: every other session would stop transitioning.
      try {
        onChange(announce);
      } catch (err) {
        log.warn('session', `auto-idle change handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, 10000);
}

/**
 * Stop the auto-idle check interval.
 */
export function stopAutoIdle(): void {
  if (idleInterval) {
    clearInterval(idleInterval);
    idleInterval = null;
  }
}

/**
 * Start cleaning up stale pendingResume entries.
 */
export function startPendingResumeCleanup(
  pendingResume: Map<string, PendingResume>,
  sessions: Map<string, Session>,
  broadcastFn: (data: ServerMessage) => Promise<void>,
): void {
  if (pendingResumeCleanupInterval) return;

  // #41: Check every 15s, but only clean up entries older than 2 min that are
  // still in CONNECTING status. This gives slow SessionStart hooks (2-5s on
  // congested systems) enough time to arrive before we clean up.
  pendingResumeCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [termId, pending] of pendingResume) {
      if (now - pending.timestamp > 120000) { // 2 minutes
        const session = sessions.get(pending.oldSessionId);
        // Only clean up if session is still in CONNECTING — if it transitioned
        // to another status, the resume succeeded and we just clean the entry
        if (session && session.status === SESSION_STATUS.CONNECTING) {
          session.status = SESSION_STATUS.IDLE;
          session.animationState = ANIMATION_STATE.IDLE;
          session.terminalId = null;
          log.info('session', `RESUME TIMEOUT: reverted session ${pending.oldSessionId?.slice(0, 8)} to idle (preserved)`);
          broadcastFn({ type: WS_TYPES.SESSION_UPDATE, session: { ...session } }).catch(() => {});
        }
        pendingResume.delete(termId);
      }
    }
  }, 15000);
}

/**
 * Stop the pending resume cleanup interval.
 */
export function stopPendingResumeCleanup(): void {
  if (pendingResumeCleanupInterval) {
    clearInterval(pendingResumeCleanupInterval);
    pendingResumeCleanupInterval = null;
  }
}
