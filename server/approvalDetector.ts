/**
 * @module approvalDetector
 * Detects when a tool call is pending user approval by starting category-based timers.
 * If PostToolUse does not arrive within the timeout, the session transitions to approval/input status.
 * PermissionRequest events provide a direct signal that bypasses the timeout heuristic.
 */
import { execSync } from 'child_process';
import { getToolTimeout, getToolCategory, getWaitingStatus, getWaitingLabel } from './config.js';
import { SESSION_STATUS, ANIMATION_STATE } from './constants.js';
import log from './logger.js';
import type { Session } from '../src/types/session.js';

/**
 * Validate PID as a positive integer.
 */
function validatePid(pid: unknown): number | null {
  const n = parseInt(String(pid), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** session_id -> timeout for tool approval detection */
const pendingToolTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Check if a PID has any child processes (i.e. a command is running).
 */
export function hasChildProcesses(pid: number): boolean {
  const validPid = validatePid(pid);
  if (!validPid) return false;
  try {
    const out = execSync(`pgrep -P ${validPid} 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 });
    return out.trim().length > 0;
  } catch (e: unknown) {
    log.debug('session', `hasChildProcesses check failed for pid=${validPid}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Start an approval detection timer for a tool invocation.
 * If PostToolUse doesn't arrive within the timeout, transitions session to approval/input.
 */
export function startApprovalTimer(
  sessionId: string,
  session: Session,
  toolName: string,
  toolInputSummary: string,
  broadcastFn: (session: Session) => Promise<void>,
): void {
  clearTimeout(pendingToolTimers.get(sessionId));

  const approvalTimeout = getToolTimeout(toolName);
  if (approvalTimeout > 0) {
    session.pendingTool = toolName;
    session.pendingToolDetail = toolInputSummary;
    const timer = setTimeout(async () => {
      pendingToolTimers.delete(sessionId);
      if (session.status === SESSION_STATUS.WORKING && session.pendingTool) {
        const category = getToolCategory(session.pendingTool);
        if (category === 'slow' && session.cachedPid && hasChildProcesses(session.cachedPid)) {
          return; // Command is running, not waiting for approval
        }

        const waitingStatus = getWaitingStatus(session.pendingTool) || SESSION_STATUS.APPROVAL;
        (session as Session).status = waitingStatus as Session['status'];
        session.animationState = ANIMATION_STATE.WAITING;
        session.waitingDetail = getWaitingLabel(session.pendingTool, session.pendingToolDetail || '');
        try {
          await broadcastFn(session);
        } catch (e: unknown) {
          log.warn('session', `Approval broadcast failed: ${(e as Error).message}`);
        }
      }
    }, approvalTimeout);
    pendingToolTimers.set(sessionId, timer);
  } else {
    session.pendingTool = null;
    session.pendingToolDetail = null;
  }
}

/**
 * Clear a pending approval timer for a session.
 * Also resets the pending tool and waiting detail on the session.
 */
export function clearApprovalTimer(sessionId: string, session: Session | null): void {
  clearTimeout(pendingToolTimers.get(sessionId));
  pendingToolTimers.delete(sessionId);
  if (session) {
    session.pendingTool = null;
    session.pendingToolDetail = null;
    session.waitingDetail = null;
  }
}
