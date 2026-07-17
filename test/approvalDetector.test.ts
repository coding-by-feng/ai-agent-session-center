// test/approvalDetector.test.ts — Tests for server/approvalDetector.ts
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { startApprovalTimer, clearApprovalTimer, hasChildProcesses, isAgentBusyOutput } from '../server/approvalDetector.js';
import { SESSION_STATUS, ANIMATION_STATE } from '../server/constants.js';

describe('approvalDetector', () => {
  describe('hasChildProcesses', () => {
    it('returns false for non-numeric PID', () => {
      expect(hasChildProcesses('abc')).toBe(false);
    });

    it('returns false for negative PID', () => {
      expect(hasChildProcesses(-1)).toBe(false);
    });

    it('returns false for zero PID', () => {
      expect(hasChildProcesses(0)).toBe(false);
    });

    it('returns false for null PID', () => {
      expect(hasChildProcesses(null)).toBe(false);
    });

    it('returns false for undefined PID', () => {
      expect(hasChildProcesses(undefined)).toBe(false);
    });

    it('returns boolean for valid PID', () => {
      // PID 1 (init/launchd) exists on all Unix systems
      const result = hasChildProcesses(1);
      expect(typeof result).toBe('boolean');
    });

    it('returns true for non-existent PID (safe default per #37)', () => {
      // #37: Returns true on error as safer default (assume still running)
      const result = hasChildProcesses(9999999);
      expect(result).toBe(true);
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
