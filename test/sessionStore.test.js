// test/sessionStore.test.js — Tests for server/sessionStore.js
import { describe, it, expect } from 'vitest';
import {
  handleEvent, getAllSessions, getSession, setSessionTitle, setSessionLabel,
  pushEvent, getEventsSince, getEventSeq,
  killSession, archiveSession, deleteSessionFromMemory,
  setSummary, setSessionAccentColor, setSessionCharacterModel,
  updateQueueCount, linkTerminalToSession,
} from '../server/sessionStore.js';
import { EVENT_TYPES, SESSION_STATUS, ANIMATION_STATE, EMOTE } from '../server/constants.js';

// Helper to create a session via SessionStart event
function createSession(sessionId, cwd = '/tmp/test-project') {
  return handleEvent({
    session_id: sessionId,
    hook_event_name: EVENT_TYPES.SESSION_START,
    cwd,
    model: 'claude-sonnet-4-5-20250514',
  });
}

describe('sessionStore', () => {
  describe('handleEvent - SessionStart', () => {
    it('creates a session with idle status', () => {
      const result = createSession('store-test-start-1');
      expect(result).toBeTruthy();
      expect(result.session.sessionId).toBe('store-test-start-1');
      expect(result.session.status).toBe(SESSION_STATUS.IDLE);
      expect(result.session.animationState).toBe(ANIMATION_STATE.IDLE);
    });

    it('stores the model from hook data', () => {
      const result = createSession('store-test-start-2');
      expect(result.session.model).toBe('claude-sonnet-4-5-20250514');
    });

    it('sets projectPath from cwd', () => {
      const result = handleEvent({
        session_id: 'store-test-cwd',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/home/user/my-project',
      });
      expect(result.session.projectPath).toBe('/home/user/my-project');
      expect(result.session.projectName).toBe('my-project');
    });
  });

  describe('handleEvent - state transitions', () => {
    it('transitions to prompting on UserPromptSubmit', () => {
      createSession('store-test-prompt-1');
      const result = handleEvent({
        session_id: 'store-test-prompt-1',
        hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
        prompt: 'Fix the bug in auth.js',
      });
      expect(result.session.status).toBe(SESSION_STATUS.PROMPTING);
      expect(result.session.animationState).toBe(ANIMATION_STATE.WALKING);
      expect(result.session.emote).toBe(EMOTE.WAVE);
      expect(result.session.currentPrompt).toBe('Fix the bug in auth.js');
    });

    it('transitions to working on PreToolUse', () => {
      createSession('store-test-tool-1');
      handleEvent({
        session_id: 'store-test-tool-1',
        hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
        prompt: 'Read file',
      });
      const result = handleEvent({
        session_id: 'store-test-tool-1',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/file.js' },
      });
      expect(result.session.status).toBe(SESSION_STATUS.WORKING);
      expect(result.session.animationState).toBe(ANIMATION_STATE.RUNNING);
    });

    it('stays working on PostToolUse', () => {
      createSession('store-test-post-tool');
      handleEvent({
        session_id: 'store-test-post-tool',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Read',
      });
      const result = handleEvent({
        session_id: 'store-test-post-tool',
        hook_event_name: EVENT_TYPES.POST_TOOL_USE,
        tool_name: 'Read',
      });
      expect(result.session.status).toBe(SESSION_STATUS.WORKING);
    });

    it('transitions to waiting on Stop', () => {
      createSession('store-test-stop-1');
      const result = handleEvent({
        session_id: 'store-test-stop-1',
        hook_event_name: EVENT_TYPES.STOP,
      });
      expect(result.session.status).toBe(SESSION_STATUS.WAITING);
    });

    it('transitions to ended on SessionEnd', () => {
      createSession('store-test-end-1');
      const result = handleEvent({
        session_id: 'store-test-end-1',
        hook_event_name: EVENT_TYPES.SESSION_END,
        reason: 'user_exit',
      });
      expect(result.session.status).toBe(SESSION_STATUS.ENDED);
      expect(result.session.animationState).toBe(ANIMATION_STATE.DEATH);
    });

    it('full lifecycle: idle -> prompting -> working -> waiting -> idle (via new prompt)', () => {
      createSession('store-test-lifecycle');

      // UserPromptSubmit -> prompting
      handleEvent({
        session_id: 'store-test-lifecycle',
        hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
        prompt: 'Do something',
      });
      let session = getSession('store-test-lifecycle');
      expect(session.status).toBe(SESSION_STATUS.PROMPTING);

      // PreToolUse -> working
      handleEvent({
        session_id: 'store-test-lifecycle',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Bash',
      });
      session = getSession('store-test-lifecycle');
      expect(session.status).toBe(SESSION_STATUS.WORKING);

      // Stop -> waiting
      handleEvent({
        session_id: 'store-test-lifecycle',
        hook_event_name: EVENT_TYPES.STOP,
      });
      session = getSession('store-test-lifecycle');
      expect(session.status).toBe(SESSION_STATUS.WAITING);
    });
  });

  describe('handleEvent - tool tracking', () => {
    it('increments tool usage counters', () => {
      createSession('store-test-tools-1');
      handleEvent({
        session_id: 'store-test-tools-1',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/a.js' },
      });
      handleEvent({
        session_id: 'store-test-tools-1',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/b.js' },
      });
      handleEvent({
        session_id: 'store-test-tools-1',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/c.js' },
      });
      const session = getSession('store-test-tools-1');
      expect(session.toolUsage.Read).toBe(2);
      expect(session.toolUsage.Edit).toBe(1);
    });

    it('adds to tool log', () => {
      createSession('store-test-toollog');
      handleEvent({
        session_id: 'store-test-toollog',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Bash',
        tool_input: { command: 'npm install' },
      });
      const session = getSession('store-test-toollog');
      expect(session.toolLog.length).toBeGreaterThan(0);
      expect(session.toolLog[0].tool).toBe('Bash');
      expect(session.toolLog[0].input).toContain('npm install');
    });

    it('caps tool log at 200 entries', () => {
      createSession('store-test-toollog-cap');
      for (let i = 0; i < 210; i++) {
        handleEvent({
          session_id: 'store-test-toollog-cap',
          hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
          tool_name: 'Read',
          tool_input: { file_path: `/tmp/file${i}.js` },
        });
      }
      const session = getSession('store-test-toollog-cap');
      expect(session.toolLog.length).toBeLessThanOrEqual(200);
    });
  });

  describe('handleEvent - prompt history', () => {
    it('stores prompt history', () => {
      createSession('store-test-prompts');
      handleEvent({
        session_id: 'store-test-prompts',
        hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
        prompt: 'First prompt',
      });
      handleEvent({
        session_id: 'store-test-prompts',
        hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
        prompt: 'Second prompt',
      });
      const session = getSession('store-test-prompts');
      expect(session.promptHistory.length).toBe(2);
      expect(session.promptHistory[0].text).toBe('First prompt');
      expect(session.promptHistory[1].text).toBe('Second prompt');
    });

    it('caps prompt history at 50', () => {
      createSession('store-test-prompt-cap');
      for (let i = 0; i < 55; i++) {
        handleEvent({
          session_id: 'store-test-prompt-cap',
          hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
          prompt: `Prompt ${i}`,
        });
      }
      const session = getSession('store-test-prompt-cap');
      expect(session.promptHistory.length).toBeLessThanOrEqual(50);
    });
  });

  describe('handleEvent - special events', () => {
    it('handles SubagentStart', () => {
      createSession('store-test-subagent');
      const result = handleEvent({
        session_id: 'store-test-subagent',
        hook_event_name: EVENT_TYPES.SUBAGENT_START,
        agent_type: 'code-reviewer',
      });
      expect(result.session.subagentCount).toBe(1);
      expect(result.session.emote).toBe(EMOTE.JUMP);
    });

    it('handles SubagentStop (decrements count)', () => {
      createSession('store-test-subagent-stop');
      handleEvent({
        session_id: 'store-test-subagent-stop',
        hook_event_name: EVENT_TYPES.SUBAGENT_START,
      });
      const result = handleEvent({
        session_id: 'store-test-subagent-stop',
        hook_event_name: EVENT_TYPES.SUBAGENT_STOP,
      });
      expect(result.session.subagentCount).toBe(0);
    });

    it('SubagentStop does not go below 0', () => {
      createSession('store-test-subagent-min');
      const result = handleEvent({
        session_id: 'store-test-subagent-min',
        hook_event_name: EVENT_TYPES.SUBAGENT_STOP,
      });
      expect(result.session.subagentCount).toBe(0);
    });

    it('handles PermissionRequest', () => {
      createSession('store-test-perm');
      handleEvent({
        session_id: 'store-test-perm',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Bash',
      });
      const result = handleEvent({
        session_id: 'store-test-perm',
        hook_event_name: EVENT_TYPES.PERMISSION_REQUEST,
        tool_name: 'Bash',
      });
      expect(result.session.status).toBe(SESSION_STATUS.APPROVAL);
    });

    it('handles PostToolUseFailure', () => {
      createSession('store-test-fail');
      handleEvent({
        session_id: 'store-test-fail',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });
      const result = handleEvent({
        session_id: 'store-test-fail',
        hook_event_name: EVENT_TYPES.POST_TOOL_USE_FAILURE,
        tool_name: 'Bash',
        error: 'Permission denied',
      });
      expect(result.session.status).toBe(SESSION_STATUS.WORKING);
    });

    it('handles TaskCompleted', () => {
      createSession('store-test-task');
      const result = handleEvent({
        session_id: 'store-test-task',
        hook_event_name: EVENT_TYPES.TASK_COMPLETED,
        task_description: 'Fix auth bug',
      });
      expect(result.session.emote).toBe(EMOTE.THUMBS_UP);
    });

    it('handles Notification', () => {
      createSession('store-test-notif');
      const result = handleEvent({
        session_id: 'store-test-notif',
        hook_event_name: EVENT_TYPES.NOTIFICATION,
        message: 'Build succeeded',
      });
      expect(result).toBeTruthy();
      expect(result.session).toBeTruthy();
    });

    it('handles PreCompact', () => {
      createSession('store-test-compact');
      const result = handleEvent({
        session_id: 'store-test-compact',
        hook_event_name: EVENT_TYPES.PRE_COMPACT,
      });
      expect(result).toBeTruthy();
    });
  });

  describe('handleEvent - returns null for missing session_id', () => {
    it('returns null when session_id is missing', () => {
      const result = handleEvent({ hook_event_name: 'SessionStart' });
      expect(result).toBe(null);
    });
  });

  describe('handleEvent - events list', () => {
    it('keeps events on session (max 50)', () => {
      createSession('store-test-events-cap');
      for (let i = 0; i < 55; i++) {
        handleEvent({
          session_id: 'store-test-events-cap',
          hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
          tool_name: 'Read',
        });
      }
      const session = getSession('store-test-events-cap');
      // SessionStart adds 1 event, plus 55 PreToolUse = 56 total, capped to 50
      expect(session.events.length).toBeLessThanOrEqual(50);
    });
  });

  describe('getAllSessions / getSession / deleteSessionFromMemory', () => {
    it('getAllSessions returns object with session data', () => {
      createSession('store-test-getall-1');
      const all = getAllSessions();
      expect(all['store-test-getall-1']).toBeTruthy();
      expect(all['store-test-getall-1'].sessionId).toBe('store-test-getall-1');
    });

    it('getSession returns session copy', () => {
      createSession('store-test-get-1');
      const session = getSession('store-test-get-1');
      expect(session).toBeTruthy();
      expect(session.sessionId).toBe('store-test-get-1');
    });

    it('getSession returns null for non-existent session', () => {
      const session = getSession('non-existent-session-xyz');
      expect(session).toBe(null);
    });

    it('deleteSessionFromMemory removes session', () => {
      createSession('store-test-delete-1');
      expect(getSession('store-test-delete-1')).toBeTruthy();
      const removed = deleteSessionFromMemory('store-test-delete-1');
      expect(removed).toBe(true);
      expect(getSession('store-test-delete-1')).toBe(null);
    });

    it('deleteSessionFromMemory returns false for non-existent session', () => {
      const removed = deleteSessionFromMemory('non-existent-delete-xyz');
      expect(removed).toBe(false);
    });
  });

  describe('setSessionTitle / setSessionLabel / setSummary', () => {
    it('setSessionTitle updates title', () => {
      createSession('store-test-title-1');
      const result = setSessionTitle('store-test-title-1', 'My Custom Title');
      expect(result).toBeTruthy();
      expect(result.title).toBe('My Custom Title');
    });

    it('setSessionTitle returns null for non-existent session', () => {
      const result = setSessionTitle('non-existent-title', 'title');
      expect(result).toBe(null);
    });

    it('setSessionLabel updates label', () => {
      createSession('store-test-label-1');
      const result = setSessionLabel('store-test-label-1', 'reviewer');
      expect(result).toBeTruthy();
      expect(result.label).toBe('reviewer');
    });

    it('setSummary updates summary', () => {
      createSession('store-test-summary-1');
      const result = setSummary('store-test-summary-1', 'This session did X and Y');
      expect(result).toBeTruthy();
      expect(result.summary).toBe('This session did X and Y');
    });
  });

  describe('killSession', () => {
    it('marks session as ended', () => {
      createSession('store-test-kill-1');
      const result = killSession('store-test-kill-1');
      expect(result).toBeTruthy();
      expect(result.status).toBe(SESSION_STATUS.ENDED);
      expect(result.animationState).toBe(ANIMATION_STATE.DEATH);
      expect(result.archived).toBe(1);
    });

    it('returns null for non-existent session', () => {
      const result = killSession('non-existent-kill');
      expect(result).toBe(null);
    });
  });

  describe('archiveSession', () => {
    it('sets archived flag', () => {
      createSession('store-test-archive-1');
      const result = archiveSession('store-test-archive-1', true);
      expect(result).toBeTruthy();
      expect(result.archived).toBe(1);
    });

    it('unsets archived flag', () => {
      createSession('store-test-archive-2');
      archiveSession('store-test-archive-2', true);
      const result = archiveSession('store-test-archive-2', false);
      expect(result).toBeTruthy();
      expect(result.archived).toBe(0);
    });
  });

  describe('event ring buffer', () => {
    it('pushEvent increments sequence', () => {
      const seq1 = getEventSeq();
      pushEvent('test', { foo: 'bar' });
      const seq2 = getEventSeq();
      expect(seq2).toBeGreaterThan(seq1);
    });

    it('getEventsSince returns events after given sequence', () => {
      const before = getEventSeq();
      pushEvent('test_type', { data: 1 });
      pushEvent('test_type', { data: 2 });
      const events = getEventsSince(before);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.every(e => e.seq > before)).toBe(true);
    });
  });

  describe('updateQueueCount', () => {
    it('updates queue count on session', () => {
      createSession('store-test-queue-1');
      const result = updateQueueCount('store-test-queue-1', 5);
      expect(result).toBeTruthy();
      expect(result.queueCount).toBe(5);
    });

    it('returns null for non-existent session', () => {
      const result = updateQueueCount('non-existent-queue', 5);
      expect(result).toBe(null);
    });
  });

  describe('setSessionAccentColor', () => {
    it('sets accent color on session', () => {
      createSession('store-test-color-1');
      setSessionAccentColor('store-test-color-1', '#ff0000');
      const session = getSession('store-test-color-1');
      expect(session.accentColor).toBe('#ff0000');
    });
  });

  describe('setSessionCharacterModel', () => {
    it('sets character model on session', () => {
      createSession('store-test-char-1');
      const result = setSessionCharacterModel('store-test-char-1', 'CustomRobot');
      expect(result).toBeTruthy();
      expect(result.characterModel).toBe('CustomRobot');
    });

    it('returns null for non-existent session', () => {
      const result = setSessionCharacterModel('non-existent-char', 'CustomRobot');
      expect(result).toBe(null);
    });
  });

  describe('Stop event - heavy work detection', () => {
    it('plays Dance animation after heavy work (>10 tool calls)', () => {
      createSession('store-test-heavy');
      // Set working status and accumulate >10 tool calls
      for (let i = 0; i < 12; i++) {
        handleEvent({
          session_id: 'store-test-heavy',
          hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
          tool_name: 'Read',
        });
      }
      const result = handleEvent({
        session_id: 'store-test-heavy',
        hook_event_name: EVENT_TYPES.STOP,
      });
      expect(result.session.animationState).toBe(ANIMATION_STATE.DANCE);
    });

    it('plays Waiting animation for light work', () => {
      createSession('store-test-light');
      handleEvent({
        session_id: 'store-test-light',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Read',
      });
      const result = handleEvent({
        session_id: 'store-test-light',
        hook_event_name: EVENT_TYPES.STOP,
      });
      expect(result.session.animationState).toBe(ANIMATION_STATE.WAITING);
      expect(result.session.emote).toBe(EMOTE.THUMBS_UP);
    });
  });

  describe('auto-generated title', () => {
    it('generates title from project name and prompt', () => {
      createSession('store-test-autotitle');
      handleEvent({
        session_id: 'store-test-autotitle',
        hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
        prompt: 'Fix the authentication bug',
      });
      const session = getSession('store-test-autotitle');
      expect(session.title.length).toBeGreaterThan(0);
      expect(session.title).toContain('test-project');
    });
  });
});
