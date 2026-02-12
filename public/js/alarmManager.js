/**
 * @module alarmManager
 * Sound and movement alerts for session state changes. Plays approval alarms (repeating every 10s),
 * input notification sounds, event-based tool sounds, and label-specific completion alerts.
 */
import * as soundManager from './soundManager.js';
import * as movementManager from './movementManager.js';
import * as settingsManager from './settingsManager.js';
import { isMuted, showToast, pinSession } from './sessionPanel.js';
import { escapeHtml as utilEscapeHtml } from './utils.js';
import { HOOK_EVENTS, TOOL_SOUND_MAP, LABELS } from './constants.js';
import { del } from './browserDb.js';

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

// Label completion alerts
export function handleLabelAlerts(session, allSessions, robotManager, removeCard, statsPanel, updateTabTitle, toggleEmptyState) {
  if (session.status !== 'ended' || isMuted(session.sessionId)) return;

  const labelUpper = (session.label || '').toUpperCase();
  const labelCfg = settingsManager.getLabelSettings();
  if (labelCfg[labelUpper]) {
    const cfg = labelCfg[labelUpper];
    if (cfg.sound && cfg.sound !== 'none') soundManager.previewSound(cfg.sound);
    if (cfg.movement && cfg.movement !== 'none') movementManager.trigger('alert', session.sessionId);
    const card = document.querySelector(`.session-card[data-session-id="${session.sessionId}"] .css-robot`);
    if (card && cfg.movement && cfg.movement !== 'none') {
      card.removeAttribute('data-movement');
      void card.offsetWidth;
      card.setAttribute('data-movement', cfg.movement);
      setTimeout(() => card.removeAttribute('data-movement'), 5000);
    }
  }

  if (labelUpper === LABELS.ONEOFF) {
    showOneoffReviewToast(session, allSessions, robotManager, removeCard, statsPanel, updateTabTitle, toggleEmptyState);
  }
}

function showOneoffReviewToast(session, allSessions, robotManager, removeCard, statsPanel, updateTabTitle, toggleEmptyState) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast oneoff-review-toast';
  const title = session.title || session.projectName || 'ONEOFF session';
  toast.innerHTML = `
    <div class="toast-title">ONEOFF DONE \u2014 Review needed</div>
    <div class="toast-msg">${utilEscapeHtml(title)}</div>
    <div class="oneoff-review-actions">
      <button class="oneoff-review-btn" data-action="review">REVIEW</button>
      <button class="oneoff-delete-btn" data-action="delete">DELETE</button>
      <button class="oneoff-dismiss-btn" data-action="dismiss">DISMISS</button>
    </div>
  `;
  container.appendChild(toast);

  toast.querySelector('[data-action="review"]').addEventListener('click', () => {
    const card = document.querySelector(`.session-card[data-session-id="${session.sessionId}"]`);
    if (card) card.click();
    toast.remove();
  });

  toast.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const sid = session.sessionId;
    await fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
    await del('sessions', sid).catch(() => {});
    removeCard(sid, true);
    robotManager.removeRobot(sid);
    delete allSessions[sid];
    statsPanel.update(allSessions);
    updateTabTitle(allSessions);
    toggleEmptyState(Object.keys(allSessions).length === 0);
    showToast('DELETED', 'ONEOFF session removed');
    toast.remove();
  });

  toast.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
    toast.remove();
  });

  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 30000);
}
