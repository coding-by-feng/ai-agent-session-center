// test/sessionMatcher.test.js — Tests for server/sessionMatcher.js
import { describe, it, expect } from 'vitest';
import { detectHookSource, reKeyResumedSession, matchSession } from '../server/sessionMatcher.js';
import { SESSION_STATUS, ANIMATION_STATE, EVENT_TYPES } from '../server/constants.js';

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

  describe('matchSession — fork routing', () => {
    function makeSession(id, overrides = {}) {
      return {
        sessionId: id, projectPath: '/proj', projectName: 'proj',
        status: SESSION_STATUS.IDLE, terminalId: null, lastTerminalId: null,
        cachedPid: null, isFork: false, ...overrides,
      };
    }

    it('routes SessionStart to fork session when fork reuses origin session_id', () => {
      const sessions = new Map();
      const origin = makeSession('origin-uuid');
      const fork = makeSession('term-xxx', { terminalId: 'term-xxx', isFork: true, originSessionId: 'origin-uuid' });
      sessions.set('origin-uuid', origin);
      sessions.set('term-xxx', fork);

      const result = matchSession(
        { session_id: 'origin-uuid', hook_event_name: EVENT_TYPES.SESSION_START,
          cwd: '/proj', agent_terminal_id: 'term-xxx' },
        sessions, new Map(), new Map(), new Map(),
      );
      expect(result).toBe(fork);
      expect(result).not.toBe(origin);
    });

    it('routes SessionEnd to fork session (terminalId already nulled, lastTerminalId set)', () => {
      const sessions = new Map();
      const origin = makeSession('origin-uuid');
      // Simulate state after PTY exit: terminalId nulled, lastTerminalId set
      const fork = makeSession('term-xxx', { terminalId: null, lastTerminalId: 'term-xxx', isFork: true });
      sessions.set('origin-uuid', origin);
      sessions.set('term-xxx', fork);

      const result = matchSession(
        { session_id: 'origin-uuid', hook_event_name: EVENT_TYPES.SESSION_END,
          cwd: '/proj', agent_terminal_id: 'term-xxx' },
        sessions, new Map(), new Map(), new Map(),
      );
      expect(result).toBe(fork);
      expect(result).not.toBe(origin);
    });

    it('caches PID on fork session, not origin', () => {
      const sessions = new Map();
      const pidToSession = new Map();
      const origin = makeSession('origin-uuid');
      const fork = makeSession('term-xxx', { terminalId: 'term-xxx', isFork: true });
      sessions.set('origin-uuid', origin);
      sessions.set('term-xxx', fork);

      matchSession(
        { session_id: 'origin-uuid', hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
          cwd: '/proj', agent_terminal_id: 'term-xxx', claude_pid: '9999' },
        sessions, new Map(), pidToSession, new Map(),
      );
      expect(pidToSession.get(9999)).toBe('term-xxx');
      expect(origin.cachedPid).toBeNull();
      expect(fork.cachedPid).toBe(9999);
    });

    it('does not re-route when agent_terminal_id session is not a fork', () => {
      const sessions = new Map();
      const origin = makeSession('origin-uuid');
      const other = makeSession('term-xxx', { terminalId: 'term-xxx', isFork: false });
      sessions.set('origin-uuid', origin);
      sessions.set('term-xxx', other);

      const result = matchSession(
        { session_id: 'origin-uuid', hook_event_name: EVENT_TYPES.SESSION_START,
          cwd: '/proj', agent_terminal_id: 'term-xxx' },
        sessions, new Map(), new Map(), new Map(),
      );
      expect(result).toBe(origin);
    });

    it('does not re-route when no agent_terminal_id in hook payload', () => {
      const sessions = new Map();
      const origin = makeSession('origin-uuid');
      sessions.set('origin-uuid', origin);

      const result = matchSession(
        { session_id: 'origin-uuid', hook_event_name: EVENT_TYPES.SESSION_START, cwd: '/proj' },
        sessions, new Map(), new Map(), new Map(),
      );
      expect(result).toBe(origin);
    });
  });

  describe('matchSession — external fallback (Priority 5)', () => {
    it('creates an external session for an unmatched interactive SessionStart', () => {
      const sessions = new Map();
      const pidToSession = new Map();
      const result = matchSession(
        { session_id: 'ext-uuid', hook_event_name: EVENT_TYPES.SESSION_START,
          cwd: '/Users/me/proj', term_program: 'iTerm.app', tty_path: '/dev/ttys001', claude_pid: '4242',
          transcript_path: '/t/x.jsonl', permission_mode: 'default' },
        sessions, new Map(), pidToSession, new Map(),
      );
      expect(result).toBeTruthy();
      expect(result.isExternal).toBe(true);
      expect(result.sessionId).toBe('ext-uuid');
      expect(result.source).toBe('iterm');
      expect(result.terminalId).toBeNull();
      expect(result.transcriptPath).toBe('/t/x.jsonl');
      expect(result.permissionMode).toBe('default');
      expect(result.cachedPid).toBe(4242);
      expect(sessions.get('ext-uuid')).toBe(result);
      expect(pidToSession.get(4242)).toBe('ext-uuid');
    });

    it('creates an external session when the first observed event is not SessionStart', () => {
      const sessions = new Map();
      const result = matchSession(
        { session_id: 'late-uuid', hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
          cwd: '/proj', tty_path: '/dev/ttys002' },
        sessions, new Map(), new Map(), new Map(),
      );
      expect(result).toBeTruthy();
      expect(result.isExternal).toBe(true);
      expect(sessions.get('late-uuid')).toBe(result);
    });

    it('drops a headless (no tty) unmatched session instead of creating a card', () => {
      const sessions = new Map();
      const result = matchSession(
        { session_id: 'headless-uuid', hook_event_name: EVENT_TYPES.SESSION_START, cwd: '/proj' },
        sessions, new Map(), new Map(), new Map(),
      );
      expect(result).toBeNull();
      expect(sessions.size).toBe(0);
    });

    it('upgrades a discovered external-<pid> card on its first non-SessionStart hook (no duplicate)', () => {
      const sessions = new Map();
      const pidToSession = new Map();
      // Simulate a process-scan discovered card keyed external-<pid>.
      const discovered = {
        sessionId: 'external-1234', projectPath: '/proj', projectName: 'proj',
        status: SESSION_STATUS.IDLE, animationState: ANIMATION_STATE.IDLE, emote: null,
        isExternal: true, cachedPid: 1234, terminalId: null,
        startedAt: 1, endedAt: null, totalToolCalls: 0, toolUsage: {},
        promptHistory: [], toolLog: [], responseLog: [],
        events: [{ type: 'SessionDiscovered', timestamp: 1, detail: 'external' }],
      };
      sessions.set('external-1234', discovered);
      pidToSession.set(1234, 'external-1234');

      const result = matchSession(
        { session_id: 'real-uuid', hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
          cwd: '/proj', tty_path: '/dev/ttys003', claude_pid: '1234' },
        sessions, new Map(), pidToSession, new Map(),
      );
      // Re-keyed in place — one card, not two.
      expect(sessions.has('external-1234')).toBe(false);
      expect(sessions.get('real-uuid')).toBe(result);
      expect(pidToSession.get(1234)).toBe('real-uuid');
      // No phantom previousSession archived from the empty discovered card.
      expect(result.previousSessions ?? []).toHaveLength(0);
    });

    it('drops an unmatched subagent event (has agent_name) instead of creating a card', () => {
      const sessions = new Map();
      const result = matchSession(
        { session_id: 'sub-uuid', hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
          cwd: '/proj', agent_name: 'researcher' },
        sessions, new Map(), new Map(), new Map(),
      );
      expect(result).toBeNull();
      expect(sessions.size).toBe(0);
    });

    it('does not create a card for an unmatched SessionEnd', () => {
      const sessions = new Map();
      const result = matchSession(
        { session_id: 'gone-uuid', hook_event_name: EVENT_TYPES.SESSION_END, cwd: '/proj' },
        sessions, new Map(), new Map(), new Map(),
      );
      expect(result).toBeNull();
      expect(sessions.size).toBe(0);
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
