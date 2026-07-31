/**
 * @module approvalDetector
 * Detects when a tool call is pending user approval by starting category-based timers.
 * If PostToolUse does not arrive within the timeout, the session transitions to approval/input status.
 * PermissionRequest events provide a direct signal that bypasses the timeout heuristic.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getToolTimeout, getToolCategory, getWaitingStatus, getWaitingLabel } from './config.js';
import { SESSION_STATUS, ANIMATION_STATE } from './constants.js';
import { stripAnsi } from '../src/lib/ansi.js';
import log from './logger.js';
import type { Session } from '../src/types/session.js';

/**
 * Matches the live "working" spinner footer the AI CLIs render while actively
 * processing — an elapsed-time counter `(… 2m 44s …)` paired with an activity cue
 * (`esc to interrupt`, a token counter, or `thinking`). Claude Code shows this
 * during extended thinking and tool execution, e.g.
 *   `✽ Enchanting… (2m 44s · ↓ 6.8k tokens · almost done thinking with xhigh effort)`
 * It is NEVER shown at an approval prompt (which has no elapsed-time spinner) or
 * when idle, so it cleanly distinguishes "still busy" from "needs approval".
 */
const BUSY_SPINNER_RE = /\((?:\s*\d+\s*h)?(?:\s*\d+\s*m)?\s*\d+\s*s\b[^)\n]*?(?:esc to interrupt|tokens?|thinking)/i;

/**
 * True when the recent terminal output shows an active thinking/working spinner —
 * i.e. the agent is busy, not waiting for tool approval. Used to suppress a false
 * approval transition that the PostToolUse-timeout heuristic would otherwise fire
 * during a long thinking phase (no child process exists, so `hasChildProcesses`
 * can't detect it). Only the tail is inspected so a stale spinner left up in
 * scrollback doesn't keep a finished turn marked "busy".
 */
export function isAgentBusyOutput(output: string | null | undefined): boolean {
  if (!output) return false;
  // The live status line is at the very bottom; older spinner redraws scroll out
  // of the tail as real output is appended once thinking ends.
  const tail = stripAnsi(output).slice(-600);
  return BUSY_SPINNER_RE.test(tail);
}

/**
 * Validate PID as a positive integer.
 */
function validatePid(pid: unknown): number | null {
  const n = parseInt(String(pid), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** session_id -> timeout for tool approval detection */
const pendingToolTimers = new Map<string, ReturnType<typeof setTimeout>>();

const execFileAsync = promisify(execFile);

/**
 * Check if a PID has any child processes (i.e. a command is running).
 *
 * **Async on purpose.** This used to be `execFileSync('pgrep', …)`, a blocking
 * fork+exec on the Node event loop, run once per approval-timer expiry per
 * session. A `pgrep` scan is proportional to the process table, so on a busy box
 * (700+ processes, high load) each call stalled the ONE loop that also serves WS
 * broadcasts, terminal relay and hook processing — every session froze while a
 * single session's timer checked its child. Awaiting keeps the loop free.
 */
export async function hasChildProcesses(pid: number): Promise<boolean> {
  const validPid = validatePid(pid);
  if (!validPid) return false;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(validPid)], { encoding: 'utf-8', timeout: 2000 });
    return stdout.trim().length > 0;
  } catch (e: unknown) {
    // #37: Return true on error as safer default — assume command is still running
    log.debug('session', `hasChildProcesses check failed for pid=${validPid}: ${(e as Error).message}`);
    return true;
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
  sessionLookupFn: (id: string) => Session | undefined,
  getTerminalOutput?: (session: Session) => string | null,
): void {
  clearTimeout(pendingToolTimers.get(sessionId));

  const approvalTimeout = getToolTimeout(toolName);
  if (approvalTimeout > 0) {
    session.pendingTool = toolName;
    session.pendingToolDetail = toolInputSummary;
    const timer = setTimeout(async () => {
      pendingToolTimers.delete(sessionId);
      // Look up the current session state instead of using stale closure reference
      const currentSession = sessionLookupFn(sessionId);
      if (!currentSession) return;
      if (currentSession.status === SESSION_STATUS.WORKING && currentSession.pendingTool) {
        // The agent is actively thinking/working (terminal shows a live spinner,
        // e.g. a long xhigh-effort "Enchanting… (2m 44s · …)" phase), not awaiting
        // approval. Skip the transition — mirrors the hasChildProcesses guard, but
        // catches in-process thinking that spawns no child process.
        if (getTerminalOutput && isAgentBusyOutput(getTerminalOutput(currentSession))) {
          return;
        }
        const category = getToolCategory(currentSession.pendingTool);
        if (category === 'slow' && currentSession.cachedPid) {
          if (await hasChildProcesses(currentSession.cachedPid)) {
            return; // Command is running, not waiting for approval
          }
        }
        // hasChildProcesses awaits, which yields the event loop — PostToolUse may
        // have landed (or the session ended) while pgrep ran. Re-read the session
        // and bail unless it is STILL parked on a pending tool, so a session that
        // finished during the check is never flipped to `approval` on stale state.
        const target = sessionLookupFn(sessionId);
        if (!target || target.status !== SESSION_STATUS.WORKING || !target.pendingTool) return;

        const waitingStatus = getWaitingStatus(target.pendingTool) || SESSION_STATUS.APPROVAL;
        target.status = waitingStatus as Session['status'];
        target.animationState = ANIMATION_STATE.WAITING;
        target.waitingDetail = getWaitingLabel(target.pendingTool, target.pendingToolDetail || '');
        try {
          await broadcastFn(target);
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
