/**
 * @module autoIdleManager
 * Transitions sessions to idle/waiting after configurable inactivity timeouts.
 * Prevents sessions from being stuck in transient states (prompting, working, approval)
 * when hooks are missed or the user abandons the session. Also cleans up stale pendingResume entries.
 */
import { AUTO_IDLE_TIMEOUTS } from './config.js';
import { SESSION_STATUS, ANIMATION_STATE, WS_TYPES } from './constants.js';
import log from './logger.js';

let idleInterval = null;
let pendingResumeCleanupInterval = null;

/**
 * Start the auto-idle check interval.
 * Transitions sessions to idle/waiting if no activity for configured durations.
 *
 * @param {Map} sessions - The sessions Map
 */
export function startAutoIdle(sessions) {
  if (idleInterval) return;

  idleInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
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
export function stopAutoIdle() {
  if (idleInterval) {
    clearInterval(idleInterval);
    idleInterval = null;
  }
}

/**
 * Start cleaning up stale pendingResume entries.
 *
 * @param {Map} pendingResume - The pendingResume Map
 * @param {Map} sessions - The sessions Map
 * @param {function} broadcastFn - Async function to broadcast updates
 */
export function startPendingResumeCleanup(pendingResume, sessions, broadcastFn) {
  if (pendingResumeCleanupInterval) return;

  pendingResumeCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [termId, pending] of pendingResume) {
      if (now - pending.timestamp > 120000) { // 2 minutes
        pendingResume.delete(termId);
        const session = sessions.get(pending.oldSessionId);
        if (session && session.status === SESSION_STATUS.CONNECTING) {
          session.status = SESSION_STATUS.ENDED;
          session.animationState = ANIMATION_STATE.DEATH;
          session.isHistorical = true;
          session.terminalId = null;
          log.info('session', `RESUME TIMEOUT: reverted session ${pending.oldSessionId?.slice(0,8)} back to ended`);
          broadcastFn({ type: WS_TYPES.SESSION_UPDATE, session: { ...session } }).catch(() => {});
        }
      }
    }
  }, 30000);
}

/**
 * Stop the pending resume cleanup interval.
 */
export function stopPendingResumeCleanup() {
  if (pendingResumeCleanupInterval) {
    clearInterval(pendingResumeCleanupInterval);
    pendingResumeCleanupInterval = null;
  }
}
