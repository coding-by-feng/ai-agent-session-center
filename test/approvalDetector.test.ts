// test/approvalDetector.test.ts — Tests for server/approvalDetector.ts
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { startApprovalTimer, clearApprovalTimer, hasChildProcesses, isAgentBusyOutput, mayAwaitApproval, toolCallInFlight } from '../server/approvalDetector.js';
import { SESSION_STATUS, ANIMATION_STATE } from '../server/constants.js';

describe('approvalDetector', () => {
  // Async on purpose: the underlying `pgrep` used to run via execFileSync, a
  // blocking fork+exec on the event loop that stalled WS broadcast, terminal
  // relay and hook processing for EVERY session while one session's approval
  // timer checked its child. Keep these awaited — a sync call would silently
  // return a Promise (always truthy) at the call site.
  describe('hasChildProcesses', () => {
    it('returns false for non-numeric PID', async () => {
      await expect(hasChildProcesses('abc')).resolves.toBe(false);
    });

    it('returns false for negative PID', async () => {
      await expect(hasChildProcesses(-1)).resolves.toBe(false);
    });

    it('returns false for zero PID', async () => {
      await expect(hasChildProcesses(0)).resolves.toBe(false);
    });

    it('returns false for null PID', async () => {
      await expect(hasChildProcesses(null)).resolves.toBe(false);
    });

    it('returns false for undefined PID', async () => {
      await expect(hasChildProcesses(undefined)).resolves.toBe(false);
    });

    it('returns a promise, not a boolean', () => {
      expect(hasChildProcesses(1)).toBeInstanceOf(Promise);
    });

    it('returns boolean for valid PID', async () => {
      // PID 1 (init/launchd) exists on all Unix systems
      const result = await hasChildProcesses(1);
      expect(typeof result).toBe('boolean');
    });

    it('returns true for non-existent PID (safe default per #37)', async () => {
      // #37: Returns true on error as safer default (assume still running)
      await expect(hasChildProcesses(9999999)).resolves.toBe(true);
    });
  });

  describe('startApprovalTimer', () => {
    it('sets pendingTool on session for known tool', () => {
      const session = {
        status: SESSION_STATUS.WORKING,
        pendingTool: null,
        pendingToolDetail: null,
      };
      const broadcastFn = vi.fn(async () => {});
      startApprovalTimer('test-session', session, 'Read', 'file.txt', broadcastFn);
      expect(session.pendingTool).toBe('Read');
      expect(session.pendingToolDetail).toBe('file.txt');
      // Clean up
      clearApprovalTimer('test-session', session);
    });

    it('clears pendingTool for unknown tool (no timeout)', () => {
      const session = {
        status: SESSION_STATUS.WORKING,
        pendingTool: 'Previous',
        pendingToolDetail: 'old detail',
      };
      const broadcastFn = vi.fn(async () => {});
      startApprovalTimer('test-session', session, 'UnknownTool', '', broadcastFn);
      // Unknown tools should have no timeout configured, so pendingTool is cleared
      expect(session.pendingTool).toBe(null);
      expect(session.pendingToolDetail).toBe(null);
    });
  });

  describe('isAgentBusyOutput', () => {
    it('detects the xhigh thinking spinner from the bug report', () => {
      expect(isAgentBusyOutput('✽ Enchanting… (2m 44s · ↓ 6.8k tokens · almost done thinking with xhigh effort)')).toBe(true);
    });

    it('detects an esc-to-interrupt thinking spinner', () => {
      expect(isAgentBusyOutput('· Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)')).toBe(true);
    });

    it('detects a short running spinner', () => {
      expect(isAgentBusyOutput('✻ Running… (5s · esc to interrupt)')).toBe(true);
    });

    it('sees through ANSI escape codes', () => {
      expect(isAgentBusyOutput('\x1b[1m\x1b[33m✽ Enchanting…\x1b[0m (2m 44s · 6.8k tokens · esc to interrupt)')).toBe(true);
    });

    it('does NOT match an approval prompt (no elapsed-time spinner)', () => {
      const prompt = 'Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)';
      expect(isAgentBusyOutput(prompt)).toBe(false);
    });

    it('does NOT match plain output, empty, or null', () => {
      expect(isAgentBusyOutput('Listed 3 files\n(5s timeout configured)')).toBe(false);
      expect(isAgentBusyOutput('')).toBe(false);
      expect(isAgentBusyOutput(null)).toBe(false);
      expect(isAgentBusyOutput(undefined)).toBe(false);
    });

    it('only inspects the tail — a stale spinner up in scrollback is ignored', () => {
      const stale = '✽ Enchanting… (1m 0s · 5k tokens · esc to interrupt)\n' + 'output line\n'.repeat(300) + 'Done.';
      expect(isAgentBusyOutput(stale)).toBe(false);
    });
  });

  describe('startApprovalTimer busy guard', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('suppresses the approval transition while the agent is thinking', () => {
      const session = { status: SESSION_STATUS.WORKING, pendingTool: null, pendingToolDetail: null };
      const broadcastFn = vi.fn(async () => {});
      const busyOutput = () => '✽ Enchanting… (2m 44s · ↓ 6.8k tokens · esc to interrupt)';
      startApprovalTimer('busy-1', session as never, 'Read', 'file.txt', broadcastFn, () => session as never, busyOutput);
      vi.advanceTimersByTime(5000); // Read timeout is 3000ms
      expect(session.status).toBe(SESSION_STATUS.WORKING);
      expect(broadcastFn).not.toHaveBeenCalled();
      clearApprovalTimer('busy-1', session as never);
    });

    it('still transitions to approval when the terminal is not showing a spinner', () => {
      const session = { status: SESSION_STATUS.WORKING, pendingTool: null, pendingToolDetail: null };
      const broadcastFn = vi.fn(async () => {});
      const idleOutput = () => 'Listed 3 files';
      startApprovalTimer('idle-1', session as never, 'Read', 'file.txt', broadcastFn, () => session as never, idleOutput);
      vi.advanceTimersByTime(5000);
      expect(session.status).toBe(SESSION_STATUS.APPROVAL);
      expect(session.animationState).toBe(ANIMATION_STATE.WAITING);
      clearApprovalTimer('idle-1', session as never);
    });
  });

  // `dontAsk` never prompts (asks become refusals). `bypassPermissions` prompts only
  // for explicit `ask` rules and the bypass-immune safety checks (e.g. a dangerous
  // `rm`), and those real dialogs send PermissionRequest plus a "permission_prompt"
  // Notification (see test/approvalPermissionMode.test.ts). So in both modes the
  // timeout heuristic is dropped: it could only guess wrong there. The reported
  // case: a bypass-mode session an hour into thinking after a Read showed "!".
  describe('mayAwaitApproval — modes where only a real signal may mean approval', () => {
    it.each(['Read', 'Edit', 'Write', 'Bash', 'WebFetch'])('a %s gets no approval timer in bypassPermissions or dontAsk', (tool) => {
      expect(mayAwaitApproval(tool, 'bypassPermissions')).toBe(false);
      expect(mayAwaitApproval(tool, 'dontAsk')).toBe(false);
    });

    it.each(['default', 'acceptEdits', 'plan', 'auto', null, undefined, ''])('mode %s may still prompt, so the timer stays', (mode) => {
      expect(mayAwaitApproval('Read', mode as string | null | undefined)).toBe(true);
      expect(mayAwaitApproval('Bash', mode as string | null | undefined)).toBe(true);
    });

    it('a question to the user still waits in every mode', () => {
      expect(mayAwaitApproval('AskUserQuestion', 'bypassPermissions')).toBe(true);
      expect(mayAwaitApproval('AskUserQuestion', 'dontAsk')).toBe(true);
    });
  });

  describe('toolCallInFlight — is a tool call still waiting for its result?', () => {
    const ev = (...types: string[]) => types.map((type) => ({ type }));
    it('yes after a PreToolUse or a PermissionRequest', () => {
      expect(toolCallInFlight(ev('UserPromptSubmit', 'PreToolUse'))).toBe(true);
      expect(toolCallInFlight(ev('PreToolUse', 'PermissionRequest'))).toBe(true);
      expect(toolCallInFlight(ev('PermissionRequest', 'Notification'))).toBe(true);
    });
    it('no once the call closed, the turn stopped, or nothing ever ran', () => {
      expect(toolCallInFlight(ev('PreToolUse', 'PostToolUse'))).toBe(false);
      expect(toolCallInFlight(ev('PreToolUse', 'PostToolUseFailure'))).toBe(false);
      expect(toolCallInFlight(ev('PreToolUse', 'Stop'))).toBe(false);
      expect(toolCallInFlight(ev('SessionStart'))).toBe(false);
      expect(toolCallInFlight([])).toBe(false);
    });
  });

  describe('startApprovalTimer in a mode that never prompts', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('bypassPermissions: a long-silent Read stays working, with no busy spinner in sight', () => {
      const session = { status: SESSION_STATUS.WORKING, pendingTool: null, pendingToolDetail: null };
      const broadcastFn = vi.fn(async () => {});
      const noSpinner = () => 'Reading 1 file…';
      startApprovalTimer('bypass-1', session as never, 'Read', '06-cache.png', broadcastFn, () => session as never, noSpinner, 'bypassPermissions');
      vi.advanceTimersByTime(60_000);
      expect(session.status).toBe(SESSION_STATUS.WORKING);
      expect(broadcastFn).not.toHaveBeenCalled();
      // the robot still shows which tool is running
      expect(session.pendingTool).toBe('Read');
      expect(session.pendingToolDetail).toBe('06-cache.png');
      clearApprovalTimer('bypass-1', session as never);
    });

    it('dontAsk: a Bash with no child process still stays working', () => {
      const session = { status: SESSION_STATUS.WORKING, pendingTool: null, pendingToolDetail: null, cachedPid: null };
      const broadcastFn = vi.fn(async () => {});
      startApprovalTimer('dontask-1', session as never, 'Bash', 'ls', broadcastFn, () => session as never, () => '', 'dontAsk');
      vi.advanceTimersByTime(60_000);
      expect(session.status).toBe(SESSION_STATUS.WORKING);
      expect(broadcastFn).not.toHaveBeenCalled();
      clearApprovalTimer('dontask-1', session as never);
    });

    it('bypassPermissions: a question still turns into input', () => {
      const session = { status: SESSION_STATUS.WORKING, pendingTool: null, pendingToolDetail: null };
      const broadcastFn = vi.fn(async () => {});
      startApprovalTimer('bypass-q', session as never, 'AskUserQuestion', 'Which one?', broadcastFn, () => session as never, () => '', 'bypassPermissions');
      vi.advanceTimersByTime(5000);
      expect(session.status).toBe(SESSION_STATUS.INPUT);
      clearApprovalTimer('bypass-q', session as never);
    });

    it('default mode is unchanged: no spinner, no answer, approval', () => {
      const session = { status: SESSION_STATUS.WORKING, pendingTool: null, pendingToolDetail: null };
      const broadcastFn = vi.fn(async () => {});
      startApprovalTimer('default-1', session as never, 'Read', 'x', broadcastFn, () => session as never, () => 'Listed 3 files', 'default');
      vi.advanceTimersByTime(5000);
      expect(session.status).toBe(SESSION_STATUS.APPROVAL);
      clearApprovalTimer('default-1', session as never);
    });
  });

  describe('clearApprovalTimer', () => {
    it('resets pending tool state on session', () => {
      const session = {
        pendingTool: 'Bash',
        pendingToolDetail: 'npm install',
        waitingDetail: 'Approve Bash: npm install',
      };
      clearApprovalTimer('test-session', session);
      expect(session.pendingTool).toBe(null);
      expect(session.pendingToolDetail).toBe(null);
      expect(session.waitingDetail).toBe(null);
    });

    it('handles null session gracefully', () => {
      // Should not throw
      clearApprovalTimer('test-session', null);
    });
  });
});
