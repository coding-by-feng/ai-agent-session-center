// test/approvalDetector.test.js — Tests for server/approvalDetector.js
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startApprovalTimer, clearApprovalTimer, hasChildProcesses } from '../server/approvalDetector.js';
import { SESSION_STATUS, ANIMATION_STATE } from '../server/constants.js';

describe('approvalDetector', () => {
  describe('hasChildProcesses', () => {
    it('returns false for non-numeric PID', () => {
      assert.equal(hasChildProcesses('abc'), false);
    });

    it('returns false for negative PID', () => {
      assert.equal(hasChildProcesses(-1), false);
    });

    it('returns false for zero PID', () => {
      assert.equal(hasChildProcesses(0), false);
    });

    it('returns false for null PID', () => {
      assert.equal(hasChildProcesses(null), false);
    });

    it('returns false for undefined PID', () => {
      assert.equal(hasChildProcesses(undefined), false);
    });

    it('returns boolean for valid PID', () => {
      // PID 1 (init/launchd) exists on all Unix systems
      const result = hasChildProcesses(1);
      assert.equal(typeof result, 'boolean');
    });

    it('returns false for non-existent PID', () => {
      // Use a very high PID that almost certainly doesn't exist
      const result = hasChildProcesses(9999999);
      assert.equal(result, false);
    });
  });

  describe('startApprovalTimer', () => {
    let timers;

    beforeEach(() => {
      timers = [];
    });

    afterEach(() => {
      // Clean up any pending timers
      for (const timer of timers) {
        clearTimeout(timer);
      }
    });

    it('sets pendingTool on session for known tool', () => {
      const session = {
        status: SESSION_STATUS.WORKING,
        pendingTool: null,
        pendingToolDetail: null,
      };
      const broadcastFn = mock.fn(async () => {});
      startApprovalTimer('test-session', session, 'Read', 'file.txt', broadcastFn);
      assert.equal(session.pendingTool, 'Read');
      assert.equal(session.pendingToolDetail, 'file.txt');
      // Clean up
      clearApprovalTimer('test-session', session);
    });

    it('clears pendingTool for unknown tool (no timeout)', () => {
      const session = {
        status: SESSION_STATUS.WORKING,
        pendingTool: 'Previous',
        pendingToolDetail: 'old detail',
      };
      const broadcastFn = mock.fn(async () => {});
      startApprovalTimer('test-session', session, 'UnknownTool', '', broadcastFn);
      // Unknown tools should have no timeout configured, so pendingTool is cleared
      assert.equal(session.pendingTool, null);
      assert.equal(session.pendingToolDetail, null);
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
      assert.equal(session.pendingTool, null);
      assert.equal(session.pendingToolDetail, null);
      assert.equal(session.waitingDetail, null);
    });

    it('handles null session gracefully', () => {
      // Should not throw
      clearApprovalTimer('test-session', null);
    });
  });
});
