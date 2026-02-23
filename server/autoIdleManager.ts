/**
 * @module autoIdleManager
 * Transitions sessions to idle/waiting after configurable inactivity timeouts.
 * Prevents sessions from being stuck in transient states (prompting, working, approval)
 * when hooks are missed or the user abandons the session. Also cleans up stale pendingResume entries.
 */
import { AUTO_IDLE_TIMEOUTS } from './config.js';
import { SESSION_STATUS, ANIMATION_STATE, WS_TYPES } from './constants.js';
import log from './logger.js';
import type { Session, PendingResume } from '../src/types/session.js';
import type { ServerMessage } from '../src/types/websocket.js';

let idleInterval: ReturnType<typeof setInterval> | null = null;
let pendingResumeCleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the auto-idle check interval.
 * Transitions sessions to idle/waiting if no activity for configured durations.
 */
export function startAutoIdle(sessions: Map<string, Session>): void {
  if (idleInterval) return;

  idleInterval = setInterval(() => {
    const now = Date.now();
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
      } else if (session.status === SESSION_STATUS.PROMPTING && elapsed > AUTO_IDLE_TIMEOUTS.prompting) {
        session.status = SESSION_STATUS.WAITING;
        session.animationState = ANIMATION_STATE.WAITING;
        session.emote = null;
      } else if (session.status === SESSION_STATUS.WAITING && elapsed > AUTO_IDLE_TIMEOUTS.waiting) {
        session.status = SESSION_STATUS.IDLE;
        session.animationState = ANIMATION_STATE.IDLE;
        session.emote = null;
      } else if (session.status !== SESSION_STATUS.WAITING && session.status !== SESSION_STATUS.PROMPTING
        && session.status !== SESSION_STATUS.APPROVAL && session.status !== SESSION_STATUS.INPUT
        && session.status !== SESSION_STATUS.CONNECTING
        && elapsed > AUTO_IDLE_TIMEOUTS.working) {
        session.status = SESSION_STATUS.IDLE;
        session.animationState = ANIMATION_STATE.IDLE;
        session.emote = null;
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
