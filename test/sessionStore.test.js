// test/sessionStore.test.js — Tests for server/sessionStore.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
      assert.ok(result);
      assert.equal(result.session.sessionId, 'store-test-start-1');
      assert.equal(result.session.status, SESSION_STATUS.IDLE);
      assert.equal(result.session.animationState, ANIMATION_STATE.IDLE);
    });

    it('stores the model from hook data', () => {
      const result = createSession('store-test-start-2');
      assert.equal(result.session.model, 'claude-sonnet-4-5-20250514');
    });

    it('sets projectPath from cwd', () => {
      const result = handleEvent({
        session_id: 'store-test-cwd',
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: '/home/user/my-project',
      });
      assert.equal(result.session.projectPath, '/home/user/my-project');
      assert.equal(result.session.projectName, 'my-project');
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
      assert.equal(result.session.status, SESSION_STATUS.PROMPTING);
      assert.equal(result.session.animationState, ANIMATION_STATE.WALKING);
      assert.equal(result.session.emote, EMOTE.WAVE);
      assert.equal(result.session.currentPrompt, 'Fix the bug in auth.js');
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
      assert.equal(result.session.status, SESSION_STATUS.WORKING);
      assert.equal(result.session.animationState, ANIMATION_STATE.RUNNING);
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
      assert.equal(result.session.status, SESSION_STATUS.WORKING);
    });

    it('transitions to waiting on Stop', () => {
      createSession('store-test-stop-1');
      const result = handleEvent({
        session_id: 'store-test-stop-1',
        hook_event_name: EVENT_TYPES.STOP,
      });
      assert.equal(result.session.status, SESSION_STATUS.WAITING);
    });

    it('transitions to ended on SessionEnd', () => {
      createSession('store-test-end-1');
      const result = handleEvent({
        session_id: 'store-test-end-1',
        hook_event_name: EVENT_TYPES.SESSION_END,
        reason: 'user_exit',
      });
      assert.equal(result.session.status, SESSION_STATUS.ENDED);
      assert.equal(result.session.animationState, ANIMATION_STATE.DEATH);
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
      assert.equal(session.status, SESSION_STATUS.PROMPTING);

      // PreToolUse -> working
      handleEvent({
        session_id: 'store-test-lifecycle',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        tool_name: 'Bash',
      });
      session = getSession('store-test-lifecycle');
      assert.equal(session.status, SESSION_STATUS.WORKING);

      // Stop -> waiting
      handleEvent({
        session_id: 'store-test-lifecycle',
        hook_event_name: EVENT_TYPES.STOP,
      });
      session = getSession('store-test-lifecycle');
      assert.equal(session.status, SESSION_STATUS.WAITING);
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
      assert.equal(session.toolUsage.Read, 2);
      assert.equal(session.toolUsage.Edit, 1);
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
      assert.ok(session.toolLog.length > 0);
      assert.equal(session.toolLog[0].tool, 'Bash');
      assert.ok(session.toolLog[0].input.includes('npm install'));
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
      assert.ok(session.toolLog.length <= 200);
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
      assert.equal(session.promptHistory.length, 2);
      assert.equal(session.promptHistory[0].text, 'First prompt');
      assert.equal(session.promptHistory[1].text, 'Second prompt');
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
      assert.ok(session.promptHistory.length <= 50);
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
      assert.equal(result.session.subagentCount, 1);
      assert.equal(result.session.emote, EMOTE.JUMP);
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
      assert.equal(result.session.subagentCount, 0);
    });

    it('SubagentStop does not go below 0', () => {
      createSession('store-test-subagent-min');
      const result = handleEvent({
        session_id: 'store-test-subagent-min',
        hook_event_name: EVENT_TYPES.SUBAGENT_STOP,
      });
      assert.equal(result.session.subagentCount, 0);
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
      assert.equal(result.session.status, SESSION_STATUS.APPROVAL);
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
      assert.equal(result.session.status, SESSION_STATUS.WORKING);
    });

    it('handles TaskCompleted', () => {
      createSession('store-test-task');
      const result = handleEvent({
        session_id: 'store-test-task',
        hook_event_name: EVENT_TYPES.TASK_COMPLETED,
        task_description: 'Fix auth bug',
      });
      assert.equal(result.session.emote, EMOTE.THUMBS_UP);
    });

    it('handles Notification', () => {
      createSession('store-test-notif');
      const result = handleEvent({
        session_id: 'store-test-notif',
        hook_event_name: EVENT_TYPES.NOTIFICATION,
        message: 'Build succeeded',
      });
      assert.ok(result);
      assert.ok(result.session);
    });

    it('handles PreCompact', () => {
      createSession('store-test-compact');
      const result = handleEvent({
        session_id: 'store-test-compact',
        hook_event_name: EVENT_TYPES.PRE_COMPACT,
      });
      assert.ok(result);
    });
  });

  describe('handleEvent - returns null for missing session_id', () => {
    it('returns null when session_id is missing', () => {
      const result = handleEvent({ hook_event_name: 'SessionStart' });
      assert.equal(result, null);
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
      assert.ok(session.events.length <= 50);
    });
  });

  describe('getAllSessions / getSession / deleteSessionFromMemory', () => {
    it('getAllSessions returns object with session data', () => {
      createSession('store-test-getall-1');
      const all = getAllSessions();
      assert.ok(all['store-test-getall-1']);
      assert.equal(all['store-test-getall-1'].sessionId, 'store-test-getall-1');
    });

    it('getSession returns session copy', () => {
      createSession('store-test-get-1');
      const session = getSession('store-test-get-1');
      assert.ok(session);
      assert.equal(session.sessionId, 'store-test-get-1');
    });

    it('getSession returns null for non-existent session', () => {
      const session = getSession('non-existent-session-xyz');
      assert.equal(session, null);
    });

    it('deleteSessionFromMemory removes session', () => {
      createSession('store-test-delete-1');
      assert.ok(getSession('store-test-delete-1'));
      const removed = deleteSessionFromMemory('store-test-delete-1');
      assert.equal(removed, true);
      assert.equal(getSession('store-test-delete-1'), null);
    });

    it('deleteSessionFromMemory returns false for non-existent session', () => {
      const removed = deleteSessionFromMemory('non-existent-delete-xyz');
      assert.equal(removed, false);
    });
  });

  describe('setSessionTitle / setSessionLabel / setSummary', () => {
    it('setSessionTitle updates title', () => {
      createSession('store-test-title-1');
      const result = setSessionTitle('store-test-title-1', 'My Custom Title');
      assert.ok(result);
      assert.equal(result.title, 'My Custom Title');
    });

    it('setSessionTitle returns null for non-existent session', () => {
      const result = setSessionTitle('non-existent-title', 'title');
      assert.equal(result, null);
    });

    it('setSessionLabel updates label', () => {
      createSession('store-test-label-1');
      const result = setSessionLabel('store-test-label-1', 'reviewer');
      assert.ok(result);
      assert.equal(result.label, 'reviewer');
    });

    it('setSummary updates summary', () => {
      createSession('store-test-summary-1');
      const result = setSummary('store-test-summary-1', 'This session did X and Y');
      assert.ok(result);
      assert.equal(result.summary, 'This session did X and Y');
    });
  });

  describe('killSession', () => {
    it('marks session as ended', () => {
      createSession('store-test-kill-1');
      const result = killSession('store-test-kill-1');
      assert.ok(result);
      assert.equal(result.status, SESSION_STATUS.ENDED);
      assert.equal(result.animationState, ANIMATION_STATE.DEATH);
      assert.equal(result.archived, 1);
    });

    it('returns null for non-existent session', () => {
      const result = killSession('non-existent-kill');
      assert.equal(result, null);
    });
  });

  describe('archiveSession', () => {
    it('sets archived flag', () => {
      createSession('store-test-archive-1');
      const result = archiveSession('store-test-archive-1', true);
      assert.ok(result);
      assert.equal(result.archived, 1);
    });

    it('unsets archived flag', () => {
      createSession('store-test-archive-2');
      archiveSession('store-test-archive-2', true);
      const result = archiveSession('store-test-archive-2', false);
      assert.ok(result);
      assert.equal(result.archived, 0);
    });
  });

  describe('event ring buffer', () => {
    it('pushEvent increments sequence', () => {
      const seq1 = getEventSeq();
      pushEvent('test', { foo: 'bar' });
      const seq2 = getEventSeq();
      assert.ok(seq2 > seq1);
    });

    it('getEventsSince returns events after given sequence', () => {
      const before = getEventSeq();
      pushEvent('test_type', { data: 1 });
      pushEvent('test_type', { data: 2 });
      const events = getEventsSince(before);
      assert.ok(events.length >= 2);
      assert.ok(events.every(e => e.seq > before));
    });
  });

  describe('updateQueueCount', () => {
    it('updates queue count on session', () => {
      createSession('store-test-queue-1');
      const result = updateQueueCount('store-test-queue-1', 5);
      assert.ok(result);
      assert.equal(result.queueCount, 5);
    });

    it('returns null for non-existent session', () => {
      const result = updateQueueCount('non-existent-queue', 5);
      assert.equal(result, null);
    });
  });

  describe('setSessionAccentColor', () => {
    it('sets accent color on session', () => {
      createSession('store-test-color-1');
      setSessionAccentColor('store-test-color-1', '#ff0000');
      const session = getSession('store-test-color-1');
      assert.equal(session.accentColor, '#ff0000');
    });
  });

  describe('setSessionCharacterModel', () => {
    it('sets character model on session', () => {
      createSession('store-test-char-1');
      const result = setSessionCharacterModel('store-test-char-1', 'CustomRobot');
      assert.ok(result);
      assert.equal(result.characterModel, 'CustomRobot');
    });

    it('returns null for non-existent session', () => {
      const result = setSessionCharacterModel('non-existent-char', 'CustomRobot');
      assert.equal(result, null);
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
      assert.equal(result.session.animationState, ANIMATION_STATE.DANCE);
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
      assert.equal(result.session.animationState, ANIMATION_STATE.WAITING);
      assert.equal(result.session.emote, EMOTE.THUMBS_UP);
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
      assert.ok(session.title.length > 0);
      assert.ok(session.title.includes('test-project'));
    });
  });
});
