// movementManager.js — Per-action movement effect configuration
// Mirrors the soundManager pattern: each action can be assigned a movement effect.

import * as settingsManager from './settingsManager.js';

// Available movement effects library
const effectLibrary = {
  none:         'None',
  sweat:        'Sweat Drops',
  'energy-ring':'Energy Ring',
  sparks:       'Sparks',
  steam:        'Steam',
  'eye-cycle':  'Eye Cycle',
  'think-pulse':'Think Pulse',
  'head-tilt':  'Head Tilt',
  float:        'Float',
  breathe:      'Breathe',
  sway:         'Sway',
  sparkle:      'Sparkle',
  bounce:       'Bounce',
  flash:        'Flash Glow',
  shake:        'Shake',
  fade:         'Fade Out',
  shrink:       'Shrink',
  dissolve:     'Dissolve',
};

// Default effect for each action
const defaultActionEffects = {
  sessionStart:   'sparkle',
  sessionEnd:     'fade',
  promptSubmit:   'eye-cycle',
  taskComplete:   'bounce',
  toolRead:       'eye-cycle',
  toolWrite:      'sweat',
  toolEdit:       'sweat',
  toolBash:       'energy-ring',
  toolGrep:       'eye-cycle',
  toolGlob:       'eye-cycle',
  toolWebFetch:   'steam',
  toolTask:       'sparks',
  toolOther:      'sweat',
  approvalNeeded: 'shake',
  inputNeeded:    'sparkle',
  alert:          'flash',
  kill:           'dissolve',
  archive:        'shrink',
  subagentStart:  'sparkle',
  subagentStop:   'fade',
};

const actionLabels = {
  sessionStart:   'Session Start',
  sessionEnd:     'Session End',
  promptSubmit:   'Prompt Submit',
  taskComplete:   'Task Complete',
  toolRead:       'Tool: Read',
  toolWrite:      'Tool: Write',
  toolEdit:       'Tool: Edit',
  toolBash:       'Tool: Bash',
  toolGrep:       'Tool: Grep',
  toolGlob:       'Tool: Glob',
  toolWebFetch:   'Tool: WebFetch',
  toolTask:       'Tool: Task',
  toolOther:      'Tool: Other',
  approvalNeeded: 'Approval Needed',
  inputNeeded:    'Input Needed',
  alert:          'Alert',
  kill:           'Kill',
  archive:        'Archive',
  subagentStart:  'Subagent Start',
  subagentStop:   'Subagent Stop',
};

const actionCategories = {
  'Session Events': ['sessionStart', 'sessionEnd', 'promptSubmit', 'taskComplete'],
  'Tool Calls':     ['toolRead', 'toolWrite', 'toolEdit', 'toolBash', 'toolGrep', 'toolGlob', 'toolWebFetch', 'toolTask', 'toolOther'],
  'System':         ['approvalNeeded', 'inputNeeded', 'alert', 'kill', 'archive', 'subagentStart', 'subagentStop'],
};

let actionEffects = {};

// Active effects per session: sessionId -> { timer, effect }
const activeEffects = new Map();

export function init() {
  const saved = settingsManager.get('movementActions');
  if (saved) {
    try {
      actionEffects = JSON.parse(saved);
    } catch (e) {
      actionEffects = {};
    }
  }
}

export function getEffectLibrary() {
  return { ...effectLibrary };
}

export function getActionEffects() {
  return { ...defaultActionEffects, ...actionEffects };
}

export function getActionLabels() {
  return { ...actionLabels };
}

export function getActionCategories() {
  return actionCategories;
}

export function setActionEffect(action, effectName) {
  actionEffects[action] = effectName;
  settingsManager.set('movementActions', JSON.stringify(actionEffects));
}

/**
 * Trigger a movement effect on a session's character element.
 * The effect is applied as a data-attribute so CSS can activate the right animation.
 * Effects auto-clear after a duration (except for persistent status effects).
 */
export function trigger(actionName, sessionId) {
  const effectName = actionEffects[actionName] || defaultActionEffects[actionName] || 'none';
  if (effectName === 'none') return;

  // Find the session card's character element
  const card = document.querySelector(`.session-card[data-id="${sessionId}"] .css-robot`);
  if (!card) return;

  // Clear any previous triggered effect
  clearEffect(sessionId);

  // Apply the effect
  card.setAttribute('data-movement', effectName);

  // Auto-clear after duration (persistent status effects like sweat are handled by CSS status selectors)
  const timer = setTimeout(() => {
    card.removeAttribute('data-movement');
    activeEffects.delete(sessionId);
  }, 3500);

  activeEffects.set(sessionId, { timer, effect: effectName });
}

export function clearEffect(sessionId) {
  const existing = activeEffects.get(sessionId);
  if (existing) {
    clearTimeout(existing.timer);
    activeEffects.delete(sessionId);
  }
  const card = document.querySelector(`.session-card[data-id="${sessionId}"] .css-robot`);
  if (card) card.removeAttribute('data-movement');
}
