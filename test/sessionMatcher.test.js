// test/sessionMatcher.test.js — Tests for server/sessionMatcher.js
import { describe, it, expect } from 'vitest';
import { detectHookSource, reKeyResumedSession } from '../server/sessionMatcher.js';
import { SESSION_STATUS, ANIMATION_STATE } from '../server/constants.js';

describe('sessionMatcher', () => {
  describe('detectHookSource', () => {
    it('detects vscode from vscode_pid', () => {
      expect(detectHookSource({ vscode_pid: '12345' })).toBe('vscode');
    });

    it('detects vscode from term_program', () => {
      expect(detectHookSource({ term_program: 'vscode-terminal' })).toBe('vscode');
    });

    it('detects vscode from "Code" in term_program', () => {
      expect(detectHookSource({ term_program: 'Code' })).toBe('vscode');
    });

    it('detects jetbrains IDEs', () => {
      const ides = ['IntelliJ', 'WebStorm', 'PyCharm', 'GoLand', 'CLion', 'PhpStorm', 'Rider', 'RubyMine', 'DataGrip', 'IDEA'];
      for (const ide of ides) {
        expect(detectHookSource({ term_program: ide })).toBe('jetbrains');
      }
    });

    it('detects iTerm', () => {
      expect(detectHookSource({ term_program: 'iTerm.app' })).toBe('iterm');
    });

    it('detects Warp', () => {
      expect(detectHookSource({ term_program: 'Warp' })).toBe('warp');
    });

    it('detects Kitty', () => {
      expect(detectHookSource({ term_program: 'kitty' })).toBe('kitty');
    });

    it('detects Ghostty from term_program', () => {
      expect(detectHookSource({ term_program: 'ghostty' })).toBe('ghostty');
    });

    it('detects Ghostty from is_ghostty flag', () => {
      expect(detectHookSource({ is_ghostty: true, term_program: '' })).toBe('ghostty');
    });

    it('detects Alacritty', () => {
      expect(detectHookSource({ term_program: 'Alacritty' })).toBe('alacritty');
    });

    it('detects WezTerm from term_program', () => {
      expect(detectHookSource({ term_program: 'WezTerm' })).toBe('wezterm');
    });

    it('detects WezTerm from wezterm_pane', () => {
      expect(detectHookSource({ wezterm_pane: '1', term_program: '' })).toBe('wezterm');
    });

    it('detects Hyper', () => {
      expect(detectHookSource({ term_program: 'Hyper' })).toBe('hyper');
    });

    it('detects Apple Terminal', () => {
      expect(detectHookSource({ term_program: 'Apple_Terminal' })).toBe('terminal');
    });

    it('detects tmux', () => {
      expect(detectHookSource({ tmux: { pane: '%0' }, term_program: '' })).toBe('tmux');
    });

    it('returns term_program as-is for unknown terminal', () => {
      expect(detectHookSource({ term_program: 'SomeCustomTerm' })).toBe('somecustomterm');
    });

    it('returns "terminal" for empty hook data', () => {
      expect(detectHookSource({})).toBe('terminal');
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
      expect(sessions.has('old-id')).toBe(false);
      // New ID should be set
      expect(sessions.has('new-id')).toBe(true);
      expect(sessions.get('new-id')).toBe(result);

      // Session should be reset
      expect(result.sessionId).toBe('new-id');
      expect(result.replacesId).toBe('old-id');
      expect(result.status).toBe(SESSION_STATUS.IDLE);
      expect(result.animationState).toBe(ANIMATION_STATE.IDLE);
      expect(result.emote).toBe(null);
      expect(result.isHistorical).toBe(false);
      expect(result.endedAt).toBe(null);
      expect(result.currentPrompt).toBe('');
      expect(result.totalToolCalls).toBe(0);
      expect(result.toolUsage).toEqual({});
      expect(result.promptHistory).toEqual([]);
      expect(result.toolLog).toEqual([]);
      expect(result.responseLog).toEqual([]);

      // Should have a SessionResumed event
      expect(result.events.length).toBe(1);
      expect(result.events[0].type).toBe('SessionResumed');

      // previousSessions should be preserved (not reset)
      expect(Array.isArray(result.previousSessions)).toBe(true);
    });
  });
});
