// test/approvalDetector.test.ts — Tests for server/approvalDetector.ts
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { startApprovalTimer, clearApprovalTimer, hasChildProcesses } from '../server/approvalDetector.js';
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
