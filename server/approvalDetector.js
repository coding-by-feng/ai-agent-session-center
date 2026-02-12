// @ts-check
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

/**
 * Validate PID as a positive integer.
 * @param {unknown} pid
 * @returns {number | null}
 */
function validatePid(pid) {
  const n = parseInt(pid, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @type {Map<string, ReturnType<typeof setTimeout>>} session_id -> timeout for tool approval detection */
const pendingToolTimers = new Map();

/**
 * Check if a PID has any child processes (i.e. a command is running).
 */
export function hasChildProcesses(pid) {
  const validPid = validatePid(pid);
  if (!validPid) return false;
  try {
    const out = execSync(`pgrep -P ${validPid} 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 });
    return out.trim().length > 0;
  } catch (e) {
    log.debug('session', `hasChildProcesses check failed for pid=${validPid}: ${e.message}`);
    return false;
  }
}

/**
 * Start an approval detection timer for a tool invocation.
 * If PostToolUse doesn't arrive within the timeout, transitions session to approval/input.
 *
 * @param {string} sessionId - The session ID
 * @param {object} session - The session object (mutated in place)
 * @param {string} toolName - The tool being invoked
 * @param {string} toolInputSummary - Summary of tool input for display
 * @param {function} broadcastFn - Async callback to broadcast session update
 */
export function startApprovalTimer(sessionId, session, toolName, toolInputSummary, broadcastFn) {
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
        session.status = waitingStatus;
        session.animationState = ANIMATION_STATE.WAITING;
        session.waitingDetail = getWaitingLabel(session.pendingTool, session.pendingToolDetail);
        try {
          await broadcastFn(session);
        } catch(e) {
          log.warn('session', `Approval broadcast failed: ${e.message}`);
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
 *
 * @param {string} sessionId - The session ID
 * @param {object} session - The session object (mutated in place)
 */
export function clearApprovalTimer(sessionId, session) {
  clearTimeout(pendingToolTimers.get(sessionId));
  pendingToolTimers.delete(sessionId);
  if (session) {
    session.pendingTool = null;
    session.pendingToolDetail = null;
    session.waitingDetail = null;
  }
}
