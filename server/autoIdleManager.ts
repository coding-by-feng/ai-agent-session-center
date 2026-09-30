/**
 * @module autoIdleManager
 * Transitions sessions to idle/waiting after configurable inactivity timeouts.
 * Prevents sessions from being stuck in transient states (prompting, working, approval)
 * when hooks are missed or the user abandons the session. Also cleans up stale pendingResume entries.
 */
import { AUTO_IDLE_TIMEOUTS } from './config.js';
import { SESSION_STATUS, ANIMATION_STATE, WS_TYPES } from './constants.js';
import log from './logger.js';
import { runRelink, shouldRelink, remoteControlNameFor } from './remoteControlDaemon.js';
import { terminalLastOutputAt } from './terminalActivity.js';
import type { Session, PendingResume } from '../src/types/session.js';
import type { ServerMessage } from '../src/types/websocket.js';

let idleInterval: ReturnType<typeof setInterval> | null = null;
let pendingResumeCleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the auto-idle check interval.
 * Transitions sessions to idle/waiting if no activity for configured durations.
 */
/**
 * A session just went idle — relink its Remote Control if the daemon is armed
 * and out of cooldown.
 *
 * Dynamically imports `sshManager` because `autoIdleManager` is loaded by
 * `sessionStore`, which `sshManager` itself pulls in: a static import here
 * closes that cycle and leaves one of the two modules half-initialised at
 * require time.
 *
 * Fire-and-forget with a swallowed error. This is an unattended background
 * nicety — a dead PTY or a terminal that has already been closed must not
 * throw out of the 10-second auto-idle interval and stop every OTHER session
 * from ever transitioning again.
 */
async function onSessionIdle(session: Session): Promise<void> {
  try {
    if (!shouldRelink(session.sessionId, Date.now())) return;
    const terminalId = session.terminalId;
    if (!terminalId) return;
    const { writeToTerminal, getTerminalGeometry } = await import('./sshManager.js');
    // Only server-owned PTYs can be written to. An Electron `pty-*` terminal
    // lives in ptyHost, where the server sees no bytes and the write would
    // silently go nowhere. `getTerminalGeometry` reads the live pty and
    // returns null for anything the server does not own, which is exactly the
    // liveness check needed here.
    if (!getTerminalGeometry(terminalId)) return;
    await runRelink({
      sessionId: session.sessionId,
      name: remoteControlNameFor(session),
      write: (data) => writeToTerminal(terminalId, data),
    });
  } catch (err) {
    log.debug('remote-control', `Relink skipped for ${session.sessionId.slice(0, 8)}: ${
      err instanceof Error ? err.message : String(err)}`);
  }
}

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
        // idle is sendable for a queue item with no open gate, and it is the
        // edge the Remote Control relink types into, so both landed in the
        // running turn.
        const lastOutput = terminalLastOutputAt(session.terminalId);
        const quietFor = lastOutput === undefined ? Infinity : now - lastOutput;
        if (elapsed > AUTO_IDLE_TIMEOUTS.prompting && quietFor > AUTO_IDLE_TIMEOUTS.prompting) {
          session.status = SESSION_STATUS.WAITING;
          session.animationState = ANIMATION_STATE.WAITING;
          session.emote = null;
        }
      } else if (session.status === SESSION_STATUS.WAITING && elapsed > AUTO_IDLE_TIMEOUTS.waiting) {
        session.status = SESSION_STATUS.IDLE;
        session.animationState = ANIMATION_STATE.IDLE;
        session.emote = null;
      } else if (session.status !== SESSION_STATUS.WAITING
        && session.status !== SESSION_STATUS.APPROVAL && session.status !== SESSION_STATUS.INPUT
        && session.status !== SESSION_STATUS.CONNECTING
        && elapsed > AUTO_IDLE_TIMEOUTS.working) {
        session.status = SESSION_STATUS.IDLE;
        session.animationState = ANIMATION_STATE.IDLE;
        session.emote = null;
      }

      // Remote Control relink, EDGE-triggered. This fires only on a
      // transition INTO idle, never once per tick for a session already
      // sitting idle — the guard is the `continue` at the top of this loop,
      // which skips IDLE sessions outright. (An explicit `prevStatus !== IDLE`
      // check was written here first; TypeScript rejected it as provably
      // always-true, which is the type system confirming the invariant rather
      // than a reason to weaken it.) The daemon applies its own arming and
      // cooldown checks, so this stays a plain notification.
      if (session.status === SESSION_STATUS.IDLE) {
        void onSessionIdle(session);
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
