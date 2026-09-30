/**
 * @module sessionJump
 * "Go to session #": type a session's badge number (the `#` on its card in
 * the rail) and switch to it. Used by the jump box (SessionJumpOverlay,
 * Alt+⌘+0 by default) and by Alt+⌘+1…9, so both share one switch path.
 */
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { numberedSessions } from '@/lib/sessionSort';
import { showToast } from '@/components/ui/ToastContainer';

export interface JumpInput {
  /** The typed number, or null before anything is typed. */
  n: number | null;
  /** A session has this number. */
  valid: boolean;
  /**
   * More digits could still make a valid number (`n*10 <= count`). The box
   * jumps at once when this is false and waits for another digit or Enter
   * while it is true — e.g. of 23 sessions, "1" waits (10–19), "13" and "3"
   * jump.
   */
  canGrow: boolean;
}

/** Pure. What `digits` (no leading zero) point at among `count` sessions. */
export function resolveJumpInput(digits: string, count: number): JumpInput {
  if (!digits) return { n: null, valid: false, canGrow: true };
  const n = Number(digits);
  return { n, valid: n >= 1 && n <= count, canGrow: n * 10 <= count };
}

/**
 * Switch to the session with badge number `n` (1-based). The session already
 * open is only un-minimized: re-selecting it would record it as its own
 * "previous" and break the switch-to-previous shortcut. False, and nothing
 * changes, when no session has that number.
 */
export function jumpToSessionNumber(n: number): boolean {
  const { sessions, selectedSessionId, selectSession } = useSessionStore.getState();
  const target = n >= 1 ? numberedSessions(sessions.values())[n - 1] : undefined;
  if (!target) return false;
  if (target.sessionId !== selectedSessionId) selectSession(target.sessionId);
  useUiStore.getState().restoreDetailPanel();
  showToast(`Switched to ${target.title || target.projectName || `session ${n}`}`, 'info', 1500);
  return true;
}
