/**
 * @module alarmManager
 * Sound and movement alerts for session state changes. Plays approval alarms (repeating every 10s),
 * input notification sounds, event-based tool sounds, and label-specific completion alerts.
 */
import * as soundManager from './soundManager.js';
import * as movementManager from './movementManager.js';
import * as settingsManager from './settingsManager.js';
import { isMuted } from './sessionPanel.js';
import { HOOK_EVENTS, TOOL_SOUND_MAP } from './constants.js';

const approvalAlarmTimers = new Map(); // sessionId -> intervalId for repeating alarm

export function getApprovalAlarmTimers() { return approvalAlarmTimers; }

export function clearAlarm(sessionId) {
  if (approvalAlarmTimers.has(sessionId)) {
    clearInterval(approvalAlarmTimers.get(sessionId));
    approvalAlarmTimers.delete(sessionId);
  }
  approvalAlarmTimers.delete('input-' + sessionId);
}

// Handle event-based sounds and movements
export function handleEventSounds(session) {
  const lastEvt = session.events[session.events.length - 1];
  if (!lastEvt || isMuted(session.sessionId)) return;

  switch (lastEvt.type) {
    case HOOK_EVENTS.SESSION_START:
      soundManager.play('sessionStart');
      movementManager.trigger('sessionStart', session.sessionId);
      break;
    case HOOK_EVENTS.USER_PROMPT_SUBMIT:
      soundManager.play('promptSubmit');
      movementManager.trigger('promptSubmit', session.sessionId);
      break;
    case HOOK_EVENTS.PRE_TOOL_USE: {
      const toolName = lastEvt.tool_name || '';
      const action = TOOL_SOUND_MAP[toolName] || 'toolOther';
      soundManager.play(action);
      movementManager.trigger(action, session.sessionId);
      break;
    }
    case HOOK_EVENTS.STOP:
      soundManager.play('taskComplete');
      movementManager.trigger('taskComplete', session.sessionId);
      break;
    case HOOK_EVENTS.SESSION_END:
      soundManager.play('sessionEnd');
      movementManager.trigger('sessionEnd', session.sessionId);
      break;
  }
}

// Handle approval/input state alarms
export function checkAlarms(session, allSessions) {
  // Approval alarm: play urgent sound when session enters approval state (repeats every 10s)
  if (session.status === 'approval' && !isMuted(session.sessionId)) {
    if (!approvalAlarmTimers.has(session.sessionId)) {
      soundManager.play('approvalNeeded');
      movementManager.trigger('approvalNeeded', session.sessionId);
      const intervalId = setInterval(() => {
        const current = allSessions[session.sessionId];
        if (!current || current.status !== 'approval' || isMuted(session.sessionId)) {
          clearInterval(intervalId);
          approvalAlarmTimers.delete(session.sessionId);
          return;
        }
        soundManager.play('approvalNeeded');
      }, 10000);
      approvalAlarmTimers.set(session.sessionId, intervalId);
    }
  } else if (session.status !== 'approval' && approvalAlarmTimers.has(session.sessionId)) {
    clearInterval(approvalAlarmTimers.get(session.sessionId));
    approvalAlarmTimers.delete(session.sessionId);
  }

  // Input notification: play a softer sound once
  if (session.status === 'input' && !isMuted(session.sessionId)) {
    if (!approvalAlarmTimers.has('input-' + session.sessionId)) {
      soundManager.play('inputNeeded');
      approvalAlarmTimers.set('input-' + session.sessionId, true);
    }
  } else if (session.status !== 'input' && approvalAlarmTimers.has('input-' + session.sessionId)) {
    approvalAlarmTimers.delete('input-' + session.sessionId);
  }
}
