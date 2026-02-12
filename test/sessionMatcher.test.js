// test/sessionMatcher.test.js — Tests for server/sessionMatcher.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectHookSource, reKeyResumedSession } from '../server/sessionMatcher.js';
import { SESSION_STATUS, ANIMATION_STATE } from '../server/constants.js';

describe('sessionMatcher', () => {
  describe('detectHookSource', () => {
    it('detects vscode from vscode_pid', () => {
      assert.equal(detectHookSource({ vscode_pid: '12345' }), 'vscode');
    });

    it('detects vscode from term_program', () => {
      assert.equal(detectHookSource({ term_program: 'vscode-terminal' }), 'vscode');
    });

    it('detects vscode from "Code" in term_program', () => {
      assert.equal(detectHookSource({ term_program: 'Code' }), 'vscode');
    });

    it('detects jetbrains IDEs', () => {
      const ides = ['IntelliJ', 'WebStorm', 'PyCharm', 'GoLand', 'CLion', 'PhpStorm', 'Rider', 'RubyMine', 'DataGrip', 'IDEA'];
      for (const ide of ides) {
        assert.equal(detectHookSource({ term_program: ide }), 'jetbrains', `Should detect ${ide} as jetbrains`);
      }
    });

    it('detects iTerm', () => {
      assert.equal(detectHookSource({ term_program: 'iTerm.app' }), 'iterm');
    });

    it('detects Warp', () => {
      assert.equal(detectHookSource({ term_program: 'Warp' }), 'warp');
    });

    it('detects Kitty', () => {
      assert.equal(detectHookSource({ term_program: 'kitty' }), 'kitty');
    });

    it('detects Ghostty from term_program', () => {
      assert.equal(detectHookSource({ term_program: 'ghostty' }), 'ghostty');
    });

    it('detects Ghostty from is_ghostty flag', () => {
      assert.equal(detectHookSource({ is_ghostty: true, term_program: '' }), 'ghostty');
    });

    it('detects Alacritty', () => {
      assert.equal(detectHookSource({ term_program: 'Alacritty' }), 'alacritty');
    });

    it('detects WezTerm from term_program', () => {
      assert.equal(detectHookSource({ term_program: 'WezTerm' }), 'wezterm');
    });

    it('detects WezTerm from wezterm_pane', () => {
      assert.equal(detectHookSource({ wezterm_pane: '1', term_program: '' }), 'wezterm');
    });

    it('detects Hyper', () => {
      assert.equal(detectHookSource({ term_program: 'Hyper' }), 'hyper');
    });

    it('detects Apple Terminal', () => {
      assert.equal(detectHookSource({ term_program: 'Apple_Terminal' }), 'terminal');
    });

    it('detects tmux', () => {
      assert.equal(detectHookSource({ tmux: { pane: '%0' }, term_program: '' }), 'tmux');
    });

    it('returns term_program as-is for unknown terminal', () => {
      assert.equal(detectHookSource({ term_program: 'SomeCustomTerm' }), 'somecustomterm');
    });

    it('returns "terminal" for empty hook data', () => {
      assert.equal(detectHookSource({}), 'terminal');
    });
  });

  describe('reKeyResumedSession', () => {
    it('transfers session from old ID to new ID', () => {
      const sessions = new Map();
      const oldSession = {
        sessionId: 'old-id',
        status: SESSION_STATUS.ENDED,
        animationState: ANIMATION_STATE.DEATH,
        emote: null,
        isHistorical: true,
        previousSessions: [],
        currentPrompt: 'old prompt',
        totalToolCalls: 5,
        toolUsage: { Read: 3 },
        promptHistory: [{ text: 'old', timestamp: 1 }],
        toolLog: [{ tool: 'Read', input: 'file', timestamp: 1 }],
        responseLog: [{ text: 'response', timestamp: 1 }],
        events: [{ type: 'SessionStart', timestamp: 1, detail: 'old' }],
      };
      sessions.set('old-id', oldSession);

      const result = reKeyResumedSession(sessions, oldSession, 'new-id', 'old-id');

      // Old ID should be removed
      assert.equal(sessions.has('old-id'), false);
      // New ID should be set
      assert.equal(sessions.has('new-id'), true);
      assert.equal(sessions.get('new-id'), result);

      // Session should be reset
      assert.equal(result.sessionId, 'new-id');
      assert.equal(result.replacesId, 'old-id');
      assert.equal(result.status, SESSION_STATUS.IDLE);
      assert.equal(result.animationState, ANIMATION_STATE.IDLE);
      assert.equal(result.emote, null);
      assert.equal(result.isHistorical, false);
      assert.equal(result.endedAt, null);
      assert.equal(result.currentPrompt, '');
      assert.equal(result.totalToolCalls, 0);
      assert.deepEqual(result.toolUsage, {});
      assert.deepEqual(result.promptHistory, []);
      assert.deepEqual(result.toolLog, []);
      assert.deepEqual(result.responseLog, []);

      // Should have a SessionResumed event
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].type, 'SessionResumed');

      // previousSessions should be preserved (not reset)
      assert.ok(Array.isArray(result.previousSessions));
    });
  });
});
